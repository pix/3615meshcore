// Minitel link test for the XIAO nRF52840.
//
// Serial1 (D6 TX, D7 RX) talks to the Minitel DIN port through the
// arduiblog 2N2222A interface (non-inverting, powered from 3V3).
// The nRF52840 UART has no 7-bit mode, so the port runs 8N1 and the even
// parity of 7E1 is put in / checked on bit 7 in software: same 10 bits on
// the wire.
//
// USB serial (115200) is the console: it logs every byte the Minitel sends
// and takes commands, one per line. Type "help".

#include <Arduino.h>
#include <initializer_list>
#include <Adafruit_TinyUSB.h>  // USB CDC "Serial" lives in this library

static uint32_t baud = 0;  // current Minitel speed, 0 = unknown
static uint32_t parityErrors = 0;

// ---- 7E1 over an 8N1 UART -------------------------------------------------

static uint8_t withParity(uint8_t c) {
  c &= 0x7F;
  return __builtin_parity(c) ? (c | 0x80) : c;
}

static void mtWrite(const uint8_t *b, size_t n) {
  for (size_t i = 0; i < n; i++) Serial1.write(withParity(b[i]));
  Serial1.flush();
}

static void mtWrite(std::initializer_list<uint8_t> b) { mtWrite(b.begin(), b.size()); }

static void mtPrint(const char *s) { mtWrite((const uint8_t *)s, strlen(s)); }

// Returns the 7-bit byte, or -1 for none / -2 for a parity error.
static int mtRead() {
  int b = Serial1.read();
  if (b < 0) return -1;
  if (__builtin_parity((uint8_t)b)) {
    parityErrors++;
    return -2;
  }
  return b & 0x7F;
}

static void mtDrain() {
  while (Serial1.available()) Serial1.read();
}

static void mtBegin(uint32_t b) {
  // Uart::end() on a UART that was never started waits forever for a
  // TXSTOPPED/RXTO event that never comes: only stop it if it is running.
  static bool started = false;
  if (started) Serial1.end();
  started = true;
  Serial1.begin(b);
  baud = b;
  delay(20);
  mtDrain();
}

// Collect the Minitel's reply for up to `ms`, stopping once `want` bytes arrived.
static size_t mtCollect(uint8_t *buf, size_t want, uint32_t ms) {
  size_t n = 0;
  uint32_t t0 = millis();
  while (millis() - t0 < ms && n < want) {
    int c = mtRead();
    if (c >= 0) buf[n++] = c;
    else delay(1);
  }
  return n;
}

static void hexdump(const char *tag, const uint8_t *b, size_t n) {
  Serial.printf("%s (%u):", tag, (unsigned)n);
  for (size_t i = 0; i < n; i++) Serial.printf(" %02X", b[i]);
  Serial.println();
}

// ---- Protocol queries (Télétel / Mixte only) ------------------------------

// PRO1 speed status: 1B 39 74 -> 1B 3A 75 <byte>.
static bool querySpeed(uint8_t *code) {
  mtDrain();
  mtWrite({0x1B, 0x39, 0x74});
  uint8_t r[4];
  size_t n = mtCollect(r, 4, 300);
  if (n == 4 && r[0] == 0x1B && r[1] == 0x3A && r[2] == 0x75) {
    if (code) *code = r[3];
    return true;
  }
  if (n) hexdump("  unexpected", r, n);
  return false;
}

static bool probe() {
  static const uint32_t speeds[] = {9600, 1200, 4800, 300};
  for (uint32_t s : speeds) {
    mtBegin(s);
    Serial.printf("probe %lu baud... ", (unsigned long)s);
    uint8_t code;
    if (querySpeed(&code)) {
      Serial.printf("answered, speed byte %02X\n", code);
      return true;
    }
    Serial.println("no answer");
  }
  Serial.println("No answer at any speed. Check wiring, or the Minitel may be in"
                 " Teleinformatique mode (Fnct T+V to go back to Videotex).");
  mtBegin(1200);
  baud = 0;
  return false;
}

static void identify() {
  mtDrain();
  mtWrite({0x1B, 0x39, 0x7B});  // ENQROM
  uint8_t r[5];
  size_t n = mtCollect(r, 5, 300);
  if (n == 5 && r[0] == 0x01 && r[4] == 0x04) {
    const char *model = r[2] == 'v' ? "Minitel 2" : "other";
    Serial.printf("ENQROM: maker '%c' type '%c' (%s) version '%c'\n", r[1], r[2], model, r[3]);
  } else {
    hexdump("ENQROM: no valid reply", r, n);
  }
}

static void status() {
  mtDrain();
  mtWrite({0x1B, 0x39, 0x72});  // operating status
  uint8_t r[4];
  size_t n = mtCollect(r, 4, 300);
  if (n == 4 && r[0] == 0x1B && r[1] == 0x3A && r[2] == 0x73) {
    uint8_t s = r[3];
    Serial.printf("status %02X: %s, %s, PCE %s, %s\n", s, (s & 1) ? "80 col (Mixte)" : "40 col",
                  (s & 2) ? "scroll" : "page", (s & 4) ? "on" : "off", (s & 8) ? "lower case" : "upper case");
  } else {
    hexdump("status: no valid reply (Teleinfo mode answers nothing)", r, n);
  }
}

static void setSpeed(uint32_t s) {
  uint8_t code;
  switch (s) {
    case 300: code = 0x52; break;
    case 1200: code = 0x64; break;
    case 4800: code = 0x76; break;
    case 9600: code = 0x7F; break;
    default: Serial.println("speed: 300, 1200, 4800 or 9600"); return;
  }
  mtWrite({0x1B, 0x3A, 0x6B, code});
  // The ack (1B 3A 75 xx) comes back at the new speed while the UART is being
  // restarted, so its first bytes are usually lost: confirm with a fresh query.
  mtBegin(s);
  delay(100);
  mtDrain();
  uint8_t got;
  if (querySpeed(&got) && got == code) Serial.printf("now at %lu baud (speed byte %02X)\n", (unsigned long)s, got);
  else Serial.println("speed change not confirmed; try 'probe'");
}

static void banner() {
  mtWrite({0x0C});  // clear screen (Vidéotex)
  char line[48];
  mtPrint("XIAO nRF52840 -> Minitel\r\n");
  snprintf(line, sizeof line, "Liaison OK a %lu bauds\r\n", (unsigned long)baud);
  mtPrint(line);
  mtPrint("Tapez au clavier: les touches\r\napparaissent sur le port USB.\r\n");
}


// Logic-analyser view of D7, timed with the Cortex-M4 cycle counter (64 MHz).
// First counts level changes over 200 ms with nothing pressed (noise), then
// waits for a key and prints the length of each high/low run. Bit time:
// 833 us = 1200 baud, 208 = 4800, 104 = 9600.
static inline uint32_t cyc() { return DWT->CYCCNT; }

static void scope(uint32_t waitMs) {
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CYCCNT = 0;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;

  uint32_t keep = baud;
  Serial1.end();
  pinMode(PIN_SERIAL1_RX, INPUT);

  // Idle noise: changes in 200 ms, and time spent low.
  uint32_t changes = 0, lowCyc = 0, t = cyc(), t0 = t;
  int lvl = digitalRead(PIN_SERIAL1_RX), first = lvl;
  while (cyc() - t0 < 64000u * 200) {
    int v = digitalRead(PIN_SERIAL1_RX);
    uint32_t now = cyc();
    if (!lvl) lowCyc += now - t;
    t = now;
    if (v != lvl) { changes++; lvl = v; }
  }
  Serial.printf("scope idle: starts %s, %lu level changes in 200 ms, low %lu%% of the time\n",
                first ? "HIGH" : "LOW", (unsigned long)changes, (unsigned long)(lowCyc / (64000u * 2)));

  Serial.printf("scope: press a key on the Minitel (waiting %lu s)...\n", (unsigned long)(waitMs / 1000));
  // Trigger on a low lasting at least 20 us, so short noise spikes are skipped.
  uint32_t w0 = millis();
  for (;;) {
    if (millis() - w0 > waitMs) {
      Serial.println("scope: no key seen");
      Serial1.begin(keep ? keep : 1200);
      return;
    }
    if (digitalRead(PIN_SERIAL1_RX)) continue;
    uint32_t a = cyc();
    while (!digitalRead(PIN_SERIAL1_RX) && cyc() - a < 64u * 20) {}
    if (cyc() - a >= 64u * 20) break;
  }
  static uint32_t runs[300];
  int n = 0, level = 0;
  uint32_t edge = cyc() - 64u * 20, start = edge;
  while (n < 300 && cyc() - start < 64000u * 30) {
    if (digitalRead(PIN_SERIAL1_RX) != level) {
      uint32_t now = cyc();
      runs[n++] = (now - edge) / 64;
      edge = now;
      level = !level;
    }
  }
  Serial.printf("scope: %d runs in 30 ms (us, L = low, H = high):\n", n);
  for (int i = 0; i < n; i++) {
    Serial.printf("%s%lu", (i % 2) ? "H" : "L", (unsigned long)runs[i]);
    Serial.print(i % 16 == 15 ? "\n" : " ");
  }
  Serial.println();
  Serial1.begin(keep ? keep : 1200);
}


// What is D7 tied to? With the UART off, read it with the internal pull-down
// (~13k) and then the pull-up. Minitel TX (DIN 3, open collector, idle = off)
// only has our 220k pull-up behind 9.1k, so the pull-down wins: LOW. A pin the
// Minitel pulls up itself (DIN 1 = its RX input) stays HIGH.
static void sense() {
  uint32_t keep = baud;
  Serial1.end();
  pinMode(PIN_SERIAL1_RX, INPUT_PULLDOWN);
  delay(5);
  int hiPD = 0;
  for (int i = 0; i < 1000; i++) hiPD += digitalRead(PIN_SERIAL1_RX);
  pinMode(PIN_SERIAL1_RX, INPUT_PULLUP);
  delay(5);
  int hiPU = 0;
  for (int i = 0; i < 1000; i++) hiPU += digitalRead(PIN_SERIAL1_RX);
  pinMode(PIN_SERIAL1_RX, INPUT);
  Serial.printf("sense D7: with pull-down HIGH %d/1000, with pull-up HIGH %d/1000\n", hiPD, hiPU);
  Serial1.begin(keep ? keep : 1200);
}

// ---- Console ---------------------------------------------------------------

static void help() {
  Serial.println(
      "Commands:\n"
      "  probe          find the Minitel's speed\n"
      "  id             ENQROM (maker / model / version)\n"
      "  status         40/80 columns, scroll, case\n"
      "  speed N        switch to 300 / 1200 / 4800 / 9600 baud\n"
      "  scope          time the raw pulses on D7 while you press a key\n"
      "  baud N         change only the XIAO's speed (to match a Teleinfo Minitel)\n"
      "  banner         clear and write a test screen\n"
      "  cls            clear the screen\n"
      "  mixte | vdt    80-column Mixte mode / back to Videotex\n"
      "  echo on|off    Minitel local echo (PRO3)\n"
      "  hex 1B 39 7B   send raw bytes\n"
      "  anything else  sent as text, followed by CR LF");
}

static void command(String l) {
  l.trim();
  if (!l.length()) return;
  if (l == "help" || l == "?") help();
  else if (l == "probe") probe();
  else if (l == "id") identify();
  else if (l == "status") status();
  else if (l.startsWith("speed ")) setSpeed(l.substring(6).toInt());
  else if (l == "scope") scope(20000);
  else if (l == "sense") sense();
  else if (l.startsWith("baud ")) {  // change only the XIAO side (Teleinfo mode has no speed command)
    mtBegin(l.substring(5).toInt());
    Serial.printf("XIAO UART now %lu baud\n", (unsigned long)baud);
  }
  else if (l == "banner") banner();
  else if (l == "cls") mtWrite({0x0C});
  else if (l == "mixte") mtWrite({0x1B, 0x3A, 0x32, 0x7D});
  else if (l == "vdt") mtWrite({0x1B, 0x3A, 0x32, 0x7E});
  else if (l == "echo off") mtWrite({0x1B, 0x3B, 0x60, 0x5A, 0x51});
  else if (l == "echo on") mtWrite({0x1B, 0x3B, 0x61, 0x5A, 0x51});
  else if (l.startsWith("hex ")) {
    uint8_t b[64];
    size_t n = 0;
    const char *p = l.c_str() + 4;
    while (*p && n < sizeof b) {
      char *end;
      long v = strtol(p, &end, 16);
      if (end == p) break;
      b[n++] = v;
      p = end;
    }
    mtWrite(b, n);
    hexdump("sent", b, n);
  } else {
    mtPrint(l.c_str());
    mtPrint("\r\n");
  }
}

// ---- Main -----------------------------------------------------------------

void setup() {
  pinMode(LED_BLUE, OUTPUT);
  digitalWrite(LED_BLUE, !LED_STATE_ON);
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);

  Serial.println("\nMinitel link test (XIAO nRF52840, Serial1 D6=TX D7=RX)");
  if (probe()) {
    identify();
    status();
    banner();
  }
  help();
}

void loop() {
  static String line;
  static uint32_t ledOff = 0;

  // Minitel -> USB: one line per burst, hex plus printable view.
  if (Serial1.available()) {
    uint8_t b[64];
    size_t n = 0;
    uint32_t last = millis();
    while (n < sizeof b && millis() - last < 20) {
      int c = mtRead();
      if (c >= 0) {
        b[n++] = c;
        last = millis();
      } else if (c == -2) {
        last = millis();
      }
    }
    if (n) {
      Serial.print("minitel:");
      for (size_t i = 0; i < n; i++) Serial.printf(" %02X", b[i]);
      Serial.print("  \"");
      for (size_t i = 0; i < n; i++) Serial.print(b[i] >= 0x20 && b[i] < 0x7F ? (char)b[i] : '.');
      Serial.println("\"");
    }
    if (parityErrors) {
      Serial.printf("  parity errors so far: %lu (wrong speed?)\n", (unsigned long)parityErrors);
      parityErrors = 0;
    }
    digitalWrite(LED_BLUE, LED_STATE_ON);
    ledOff = millis() + 50;
  }
  if (ledOff && millis() > ledOff) {
    digitalWrite(LED_BLUE, !LED_STATE_ON);
    ledOff = 0;
  }

  // USB -> commands.
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r' || c == '\n') {
      command(line);
      line = "";
    } else if (line.length() < 200) {
      line += c;
    }
  }
}
