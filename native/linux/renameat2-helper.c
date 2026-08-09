#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stdint.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif

#define STATE_DIRECTORY_FD 3
#define QUARANTINE_DIRECTORY_FD 4
#define SOURCE_NAME "broker.sock"
#define DESTINATION_NAME "broker.sock"
#define EXIT_INTERNAL_FAILURE 70
#define EXIT_LINK_COUNT_INVALID 73
#define EXIT_LINK_COUNT_RACE_UNRECOVERABLE 74

static int is_directory_fd(int fd) {
  struct stat metadata;
  return fstat(fd, &metadata) == 0 && S_ISDIR(metadata.st_mode);
}

#ifndef AGENT_ORCHESTRATION_TEST_FORCE_RENAMEAT2_UNSUPPORTED
static int load_single_link_socket(int directory_fd, const char *name, struct stat *metadata) {
  if (fstatat(directory_fd, name, metadata, AT_SYMLINK_NOFOLLOW) != 0) {
    return errno == ENOENT ? ENOENT : EXIT_INTERNAL_FAILURE;
  }
  if (!S_ISSOCK(metadata->st_mode) || metadata->st_nlink != 1) {
    return EXIT_LINK_COUNT_INVALID;
  }
  return 0;
}

static int same_object(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}
#endif

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1 || !is_directory_fd(STATE_DIRECTORY_FD) || !is_directory_fd(QUARANTINE_DIRECTORY_FD)) {
    return EXIT_INTERNAL_FAILURE;
  }

#ifdef AGENT_ORCHESTRATION_TEST_FORCE_RENAMEAT2_UNSUPPORTED
  return ENOSYS;
#else
  struct stat source_metadata;
  const int source_status = load_single_link_socket(STATE_DIRECTORY_FD, SOURCE_NAME, &source_metadata);
  if (source_status != 0) return source_status;

  const long result = syscall(
    SYS_renameat2,
    STATE_DIRECTORY_FD,
    SOURCE_NAME,
    QUARANTINE_DIRECTORY_FD,
    DESTINATION_NAME,
    RENAME_NOREPLACE
  );

  if (result == 0) {
    struct stat destination_metadata;
    const int destination_status = load_single_link_socket(
      QUARANTINE_DIRECTORY_FD,
      DESTINATION_NAME,
      &destination_metadata
    );
    if (destination_status == 0 && same_object(&source_metadata, &destination_metadata)) return 0;

    const long restored = syscall(
      SYS_renameat2,
      QUARANTINE_DIRECTORY_FD,
      DESTINATION_NAME,
      STATE_DIRECTORY_FD,
      SOURCE_NAME,
      RENAME_NOREPLACE
    );
    if (restored == 0) return EXIT_LINK_COUNT_INVALID;
    return EXIT_LINK_COUNT_RACE_UNRECOVERABLE;
  }
  if (errno == EEXIST) return EEXIST;
  if (errno == ENOENT) return ENOENT;
  if (errno == ENOSYS || errno == EINVAL || errno == EOPNOTSUPP) return ENOSYS;
  return EXIT_INTERNAL_FAILURE;
#endif
}
