// Host harness around the firmware's own encoder (MinitelScreen.cpp / MinitelCharset.cpp),
// compiled from the firmware tree by test/run-tests.sh. Reads commands on stdin:
//   W <40|80>                    new screen of that width
//   C <row> <col> <cell> <attr>  set one cell (raw byte / attribute bits, as ScreenBuf holds them)
//   S <row> <c0> <c1>            print encodeSpan(row, c0, c1) as hex
//   L                            print encodeClear as hex
#define private public
#include "MinitelScreen.h"
#undef private
#include <stdio.h>
#include <string.h>

using namespace minitel;

static void hex(const uint8_t* b, size_t n) {
  for (size_t i = 0; i < n; i++) printf("%02X", b[i]);
  printf("\n");
}

int main() {
  static ScreenBuf s;
  Mode m = Mode::Videotex40;
  char line[256];
  static uint8_t out[16384];
  while (fgets(line, sizeof(line), stdin)) {
    int a, b, c, d;
    if (line[0] == 'W' && sscanf(line + 1, "%d", &a) == 1) {
      s.setWidth(a);
      m = a == 80 ? Mode::Mixte80 : Mode::Videotex40;
    } else if (line[0] == 'C' && sscanf(line + 1, "%d %d %d %d", &a, &b, &c, &d) == 4) {
      s._ch[a - 1][b - 1] = (uint8_t)c;
      s._at[a - 1][b - 1] = (uint8_t)d;
    } else if (line[0] == 'S' && sscanf(line + 1, "%d %d %d", &a, &b, &c) == 3) {
      hex(out, encodeSpan(s, a, b, c, m, out, sizeof(out)));
    } else if (line[0] == 'L') {
      hex(out, encodeClear(m, out, sizeof(out)));
    }
    fflush(stdout);
  }
  return 0;
}
