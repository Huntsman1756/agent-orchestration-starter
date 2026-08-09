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

static int is_directory_fd(int fd) {
  struct stat metadata;
  return fstat(fd, &metadata) == 0 && S_ISDIR(metadata.st_mode);
}

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1 || !is_directory_fd(STATE_DIRECTORY_FD) || !is_directory_fd(QUARANTINE_DIRECTORY_FD)) {
    return EXIT_INTERNAL_FAILURE;
  }

#ifdef AGENT_ORCHESTRATION_TEST_FORCE_RENAMEAT2_UNSUPPORTED
  errno = ENOSYS;
  const long result = -1;
#else
  const long result = syscall(
    SYS_renameat2,
    STATE_DIRECTORY_FD,
    SOURCE_NAME,
    QUARANTINE_DIRECTORY_FD,
    DESTINATION_NAME,
    RENAME_NOREPLACE
  );
#endif

  if (result == 0) return 0;
  if (errno == EEXIST) return EEXIST;
  if (errno == ENOENT) return ENOENT;
  if (errno == ENOSYS || errno == EINVAL || errno == EOPNOTSUPP) return ENOSYS;
  return EXIT_INTERNAL_FAILURE;
}
