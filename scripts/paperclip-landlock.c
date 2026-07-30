#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef O_PATH
#define O_PATH 010000000
#endif

struct path_rule {
  const char *path;
  bool writable;
};

static int create_ruleset(const struct landlock_ruleset_attr *attr,
                          size_t size, __u32 flags) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int add_rule(int ruleset_fd, enum landlock_rule_type type,
                    const void *attr, __u32 flags) {
  return (int)syscall(__NR_landlock_add_rule, ruleset_fd, type, attr, flags);
}

static int restrict_self(int ruleset_fd, __u32 flags) {
  return (int)syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}

static void fail(const char *message) {
  fprintf(stderr, "paperclip-landlock: %s: %s\n", message, strerror(errno));
  exit(126);
}

static void usage(void) {
  fputs(
      "usage: paperclip-landlock [--ro PATH | --rw PATH]... "
      "--cwd PATH -- COMMAND [ARG...]\n",
      stderr);
  exit(126);
}

static __u64 handled_access_for_abi(int abi) {
  __u64 access =
      LANDLOCK_ACCESS_FS_EXECUTE |
      LANDLOCK_ACCESS_FS_WRITE_FILE |
      LANDLOCK_ACCESS_FS_READ_FILE |
      LANDLOCK_ACCESS_FS_READ_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_FILE |
      LANDLOCK_ACCESS_FS_MAKE_CHAR |
      LANDLOCK_ACCESS_FS_MAKE_DIR |
      LANDLOCK_ACCESS_FS_MAKE_REG |
      LANDLOCK_ACCESS_FS_MAKE_SOCK |
      LANDLOCK_ACCESS_FS_MAKE_FIFO |
      LANDLOCK_ACCESS_FS_MAKE_BLOCK |
      LANDLOCK_ACCESS_FS_MAKE_SYM;
#ifdef LANDLOCK_ACCESS_FS_REFER
  if (abi >= 2) access |= LANDLOCK_ACCESS_FS_REFER;
#endif
#ifdef LANDLOCK_ACCESS_FS_TRUNCATE
  if (abi >= 3) access |= LANDLOCK_ACCESS_FS_TRUNCATE;
#endif
#ifdef LANDLOCK_ACCESS_FS_IOCTL_DEV
  if (abi >= 5) access |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
#endif
  return access;
}

static __u64 readonly_access_for_abi(int abi) {
  __u64 access =
      LANDLOCK_ACCESS_FS_EXECUTE |
      LANDLOCK_ACCESS_FS_READ_FILE |
      LANDLOCK_ACCESS_FS_READ_DIR;
#ifdef LANDLOCK_ACCESS_FS_IOCTL_DEV
  if (abi >= 5) access |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
#endif
  return access;
}

static __u64 allowed_access_for_path(int path_fd, __u64 requested_access) {
  struct stat path_stat;
  if (fstat(path_fd, &path_stat) < 0) fail("inspecting filesystem rule path");
  if (S_ISDIR(path_stat.st_mode)) return requested_access;

  __u64 file_access =
      LANDLOCK_ACCESS_FS_EXECUTE |
      LANDLOCK_ACCESS_FS_WRITE_FILE |
      LANDLOCK_ACCESS_FS_READ_FILE;
#ifdef LANDLOCK_ACCESS_FS_TRUNCATE
  file_access |= LANDLOCK_ACCESS_FS_TRUNCATE;
#endif
#ifdef LANDLOCK_ACCESS_FS_IOCTL_DEV
  if (S_ISCHR(path_stat.st_mode) || S_ISBLK(path_stat.st_mode)) {
    file_access |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
  }
#endif
  return requested_access & file_access;
}

int main(int argc, char **argv) {
  struct path_rule *rules = calloc((size_t)argc, sizeof(*rules));
  if (!rules) fail("allocating path rules");

  size_t rule_count = 0;
  const char *cwd = NULL;
  int command_index = -1;
  for (int index = 1; index < argc; index++) {
    if (strcmp(argv[index], "--") == 0) {
      command_index = index + 1;
      break;
    }
    if (strcmp(argv[index], "--ro") == 0 ||
        strcmp(argv[index], "--rw") == 0) {
      if (++index >= argc) usage();
      rules[rule_count++] = (struct path_rule){
          .path = argv[index],
          .writable = strcmp(argv[index - 1], "--rw") == 0,
      };
      continue;
    }
    if (strcmp(argv[index], "--cwd") == 0) {
      if (++index >= argc) usage();
      cwd = argv[index];
      continue;
    }
    usage();
  }
  if (!cwd || command_index < 0 || command_index >= argc || rule_count == 0) {
    usage();
  }

  errno = 0;
  const int abi = create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) fail("Landlock is unavailable in this kernel");

  const __u64 handled_access = handled_access_for_abi(abi);
  const __u64 readonly_access = readonly_access_for_abi(abi);
  const struct landlock_ruleset_attr ruleset_attr = {
      .handled_access_fs = handled_access,
  };
  const int ruleset_fd =
      create_ruleset(&ruleset_attr, sizeof(ruleset_attr), 0);
  if (ruleset_fd < 0) fail("creating ruleset");

  for (size_t index = 0; index < rule_count; index++) {
    const int parent_fd =
        open(rules[index].path, O_PATH | O_CLOEXEC);
    if (parent_fd < 0) fail(rules[index].path);
    const __u64 requested_access =
        rules[index].writable ? handled_access : readonly_access;
    const struct landlock_path_beneath_attr path_attr = {
        .allowed_access = allowed_access_for_path(parent_fd, requested_access),
        .parent_fd = parent_fd,
    };
    if (add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &path_attr, 0) < 0) {
      close(parent_fd);
      fail("adding filesystem rule");
    }
    close(parent_fd);
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
    fail("setting no_new_privs");
  }
  if (restrict_self(ruleset_fd, 0) < 0) {
    fail("applying ruleset");
  }
  close(ruleset_fd);
  free(rules);

  if (prctl(PR_SET_PDEATHSIG, SIGTERM) < 0) {
    fail("setting parent-death signal");
  }
  if (setsid() < 0 && errno != EPERM) fail("starting a new session");
  if (chdir(cwd) < 0) fail("changing directory");

  execvp(argv[command_index], &argv[command_index]);
  fail("executing command");
  return 126;
}
