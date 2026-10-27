// A single no-replace namespace capture, relative to identity-checked parents.
// There is deliberately no check-then-rename fallback on unsupported systems.
#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif

static int parent(char *file, const char *device, const char *inode, char **name) {
  char *slash = strrchr(file, '/');
  if (!slash || !slash[1]) { errno = EINVAL; return -1; }
  *name = slash + 1;
  *slash = '\0';
  int fd = open(*file ? file : "/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat identity;
  if (fd < 0) return -1;
  if (fstat(fd, &identity) || (uint64_t)identity.st_dev != strtoull(device, NULL, 10)
    || (uint64_t)identity.st_ino != strtoull(inode, NULL, 10)) {
    close(fd); errno = ESTALE; return -1;
  }
  return fd;
}

int main(int argc, char **argv) {
  if (argc != 7) return 74;
  char *source, *destination;
  int from = parent(argv[1], argv[3], argv[4], &source);
  int to = from < 0 ? -1 : parent(argv[2], argv[5], argv[6], &destination);
  int result = -1;
  if (from >= 0 && to >= 0) {
#ifdef __APPLE__
    result = renameatx_np(from, source, to, destination, RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
    result = (int)syscall(SYS_renameat2, from, source, to, destination, 1 /* RENAME_NOREPLACE */);
#else
    errno = ENOTSUP;
#endif
  }
  int failure = result == 0 ? 0 : errno;
  if (from >= 0) close(from);
  if (to >= 0) close(to);
  if (failure) fprintf(stderr, "Build output capture refused: %s\n", strerror(failure));
  return failure == 0 ? 0 : failure == EEXIST ? 73 : 74;
}
