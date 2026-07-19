// hwbridge.js — the sim-to-real bridge. Streams the Forge sim's actuator commands out of the
// browser to real robot hardware, on-device and ~$0. Extensible by design: a TARGET picks a
// TRANSPORT (how the bytes leave the browser) × a CODEC (the wire protocol) so new boards and
// ecosystems drop in without touching the rest.
//
//   TRANSPORTS : serial (WebSerial/USB) · ble (Web Bluetooth, Nordic UART) · ws (WebSocket, rosbridge)
//   CODECS     : pwm-text · ssc32 · maestro · feetech-scs · dynamixel2 · rosbridge
//   TARGETS    : Arduino/ESP32/Pico/Teensy/micro:bit · Pololu Maestro · Lynxmotion SSC-32 ·
//                Feetech STS/SMS (LeRobot SO-100/101) · ROBOTIS Dynamixel X · ROS 2 (rosbridge)
//
// Each codec is a PURE function (normalized targets 0..1 → wire bytes/text) so it is unit-tested
// against the documented protocol without hardware. What CANNOT be verified here is a physical
// actuator moving — that needs the board in hand.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join(' ');
// MQTT helpers: length-prefixed UTF-8 string + remaining-length varint.
function mqttStr(s) { const b = [...new TextEncoder().encode(s)]; return [(b.length >> 8) & 0xFF, b.length & 0xFF, ...b]; }
function mqttVarint(n) { const out = []; do { let d = n & 0x7F; n >>>= 7; if (n) d |= 0x80; out.push(d); } while (n); return out; }
// LEGO Wireless Protocol 3 GATT service + characteristic (SPIKE / Technic / MINDSTORMS hubs).
const LEGO_SVC = '00001623-1212-efde-1623-785feabcd123', LEGO_CHAR = '00001624-1212-efde-1623-785feabcd123';
// OSC string: null-terminated, zero-padded to a 4-byte boundary.
function oscStr(s) { const b = [...new TextEncoder().encode(s), 0]; while (b.length % 4) b.push(0); return b; }
function f32(v, le) { const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, v, le); return [dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)]; }

// normalize actuator commands to 0..1 within each actuator's ctrl range
export function normalize(ctrl, ranges) {
  return ctrl.map((c, i) => {
    const r = ranges && ranges[i] ? ranges[i] : [-1, 1];
    const lo = r[0], hi = r[1], sp = (hi - lo) || 1;
    return clamp((c - lo) / sp, 0, 1);
  });
}

// CRC-16/BUYPASS (poly 0x8005, init 0, no reflection) — exactly what ROBOTIS Dynamixel 2.0 uses.
function crc16(data) {
  let crc = 0;
  for (const b of data) {
    crc ^= (b << 8);
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x8005) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc & 0xFFFF;
}

// ── CODECS: normalized targets t[]∈[0,1] (+ opts.ids / opts.names) → { data, text } ──
export const CODECS = {
  // Generic PWM over an MCU running our firmware. us = 500..2500. `#u0,u1,...\n`.
  'pwm-text': {
    label: 'PWM text', binary: false,
    encode(t) { const us = t.map((v) => Math.round(500 + v * 2000)); const s = '#' + us.join(',') + '\n'; return { data: s, text: s.trim() }; },
  },
  // Lynxmotion SSC-32(U): `#<ch> P<us>` groups, <CR> terminated.
  ssc32: {
    label: 'Lynxmotion SSC-32', binary: false,
    encode(t) { const s = t.map((v, i) => '#' + i + ' P' + Math.round(500 + v * 2000)).join(' ') + '\r'; return { data: s, text: s.trim() }; },
  },
  // Pololu Maestro compact protocol, Set Target 0x84: target is in quarter-microseconds, 7-bit split.
  maestro: {
    label: 'Pololu Maestro', binary: true,
    encode(t) {
      const bytes = [];
      t.forEach((v, ch) => { const q = Math.round((500 + v * 2000) * 4); bytes.push(0x84, ch & 0x7F, q & 0x7F, (q >> 7) & 0x7F); });
      const u = Uint8Array.from(bytes); return { data: u, text: hex(u) };
    },
  },
  // Feetech STS/SMS (Protocol 0) SYNC WRITE goal position (addr 42), 2 bytes little-endian, 0..4095.
  // This is the LeRobot SO-100/SO-101 + Waveshare ST3215 bus. IDs default to 1..N.
  'feetech-scs': {
    label: 'Feetech STS/SMS (LeRobot) [beta]', binary: true, baud: 1000000,
    encode(t, opts) {
      const ids = (opts && opts.ids) || t.map((_, i) => i + 1);
      const ADDR = 42, L = 2, N = t.length;
      const body = [ADDR, L];
      t.forEach((v, i) => { const p = Math.round(v * 4095); body.push(ids[i] & 0xFF, p & 0xFF, (p >> 8) & 0xFF); });
      const len = (L + 1) * N + 4;
      const pkt = [0xFF, 0xFF, 0xFE, len, 0x83, ...body];
      let sum = 0; for (let i = 2; i < pkt.length; i++) sum += pkt[i];
      pkt.push((~sum) & 0xFF);
      const u = Uint8Array.from(pkt); return { data: u, text: hex(u) };
    },
  },
  // ROBOTIS Dynamixel Protocol 2.0 SYNC WRITE goal position (addr 116, 4 bytes LE, X-series 0..4095).
  dynamixel2: {
    label: 'ROBOTIS Dynamixel X (2.0) [beta]', binary: true, baud: 1000000,
    encode(t, opts) {
      const ids = (opts && opts.ids) || t.map((_, i) => i + 1);
      const ADDR = 116, L = 4, N = t.length;
      const params = [ADDR & 0xFF, (ADDR >> 8) & 0xFF, L & 0xFF, (L >> 8) & 0xFF];
      t.forEach((v, i) => { const p = Math.round(v * 4095); params.push(ids[i] & 0xFF, p & 0xFF, (p >> 8) & 0xFF, (p >> 16) & 0xFF, (p >> 24) & 0xFF); });
      const length = params.length + 3;                 // instr + params + 2 CRC
      const head = [0xFF, 0xFF, 0xFD, 0x00, 0xFE, length & 0xFF, (length >> 8) & 0xFF, 0x83, ...params];
      const c = crc16(head);
      head.push(c & 0xFF, (c >> 8) & 0xFF);
      const u = Uint8Array.from(head); return { data: u, text: hex(u) };
    },
  },
  // Firmata (StandardFirmata on ANY Arduino — no custom firmware). init() sets each pin to
  // SERVO mode; each tick writes an angle 0..180 via the Extended Analog sysex (pins >15 OK).
  firmata: {
    label: 'Firmata (any Arduino · no custom firmware)', binary: true, baud: 57600,
    init(cfg) { const n = (cfg && cfg.channels) || 8; const b = []; for (let i = 0; i < n; i++) b.push(0xF4, i, 0x04); return Uint8Array.from(b); },
    encode(t) {
      const b = [];
      t.forEach((v, pin) => { const val = Math.round(v * 180); b.push(0xF0, 0x6F, pin & 0x7F, val & 0x7F, (val >> 7) & 0x7F, 0xF7); });
      const u = Uint8Array.from(b); return { data: u, text: hex(u) };
    },
  },
  // ODrive BLDC motor controllers (real legged-robot motors). ASCII: `w axisN.controller.input_pos <turns>`.
  odrive: {
    label: 'ODrive (BLDC motor controllers)', binary: false, baud: 115200,
    encode(t) { const s = t.map((v, i) => 'w axis' + i + '.controller.input_pos ' + (v - 0.5).toFixed(3)).join('\n') + '\n'; return { data: s, text: s.trim().replace(/\n/g, ' | ') }; },
  },
  // LEGO SPIKE/Technic/MINDSTORMS hub over LWP3. One Port Output Command (0x81) per port:
  // GotoAbsolutePosition (0x0D), position int32 LE degrees, speed, maxpower, endstate=hold. Each
  // command is a DISCRETE BLE write (returned as an array so the transport won't merge them).
  lego: {
    label: 'LEGO SPIKE / Technic hub (BLE)', binary: true,
    encode(t) {
      const cmds = t.map((v, port) => {
        const deg = Math.round((v - 0.5) * 180), p = deg >>> 0;
        return Uint8Array.from([0x0E, 0x00, 0x81, port & 0xFF, 0x11, 0x0D, p & 0xFF, (p >> 8) & 0xFF, (p >> 16) & 0xFF, (p >> 24) & 0xFF, 40, 100, 126, 0]);
      });
      return { data: cmds, text: cmds.map((c) => hex(c)).join('   ') };
    },
  },
  // MQTT (Home Assistant / ESPHome / IoT) over WebSocket. CONNECT on init, then PUBLISH a JSON
  // joint array to a topic each tick (QoS 0). Minimal MQTT 3.1.1.
  mqtt: {
    label: 'MQTT (Home Assistant / ESPHome / IoT)', binary: true,
    init() {
      const vh = [...mqttStr('MQTT'), 0x04, 0x02, 0x00, 0x3C];   // protocol, level 4, clean session, keepalive 60
      const pl = mqttStr('forge-' + (Math.floor(1e6) + 1));      // client id (fixed-ish; no RNG in shared code)
      const body = [...vh, ...pl];
      return Uint8Array.from([0x10, ...mqttVarint(body.length), ...body]);
    },
    encode(t, opts) {
      const topic = (opts && opts.topic) || 'forge/joints';
      const payload = [...new TextEncoder().encode(JSON.stringify(t.map((v) => Math.round(v * 1000) / 1000)))];
      const body = [...mqttStr(topic), ...payload];               // QoS 0 → no packet id
      const u = Uint8Array.from([0x30, ...mqttVarint(body.length), ...body]);
      return { data: u, text: 'PUBLISH ' + topic + ' ' + JSON.stringify(t.map((v) => Math.round(v * 100) / 100)).slice(0, 70) };
    },
  },
  // OSC (TouchDesigner / Max / SuperCollider / creative robotics) over WebSocket. One message
  // /forge/joints with N float32 args, big-endian per the OSC spec.
  osc: {
    label: 'OSC (TouchDesigner / Max / SuperCollider)', binary: true,
    encode(t) {
      const addr = oscStr('/forge/joints'), tags = oscStr(',' + 'f'.repeat(t.length)), args = [];
      t.forEach((v) => args.push(...f32(v, false)));   // OSC is big-endian
      const u = Uint8Array.from([...addr, ...tags, ...args]);
      return { data: u, text: '/forge/joints ' + t.map((v) => v.toFixed(2)).join(' ') };
    },
  },
  // CAN bus via an SLCAN (Lawicel) USB-CAN adapter, framed for ODrive-CAN Set_Input_Pos (cmd 0x0C).
  // `t<id3><dlc><data>` per channel: arbitration = (axis<<5)|0x0C, payload = float32 input_pos LE + ff.
  slcan: {
    label: 'CAN bus · ODrive (SLCAN adapter)', binary: false,
    encode(t) {
      const lines = t.map((v, i) => {
        const id = ((i << 5) | 0x0C) & 0x7FF;
        const bytes = [...f32(v - 0.5, true), 0, 0, 0, 0];
        const hd = bytes.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        return 't' + id.toString(16).padStart(3, '0').toUpperCase() + '8' + hd;
      }).join('\r') + '\r';
      return { data: lines, text: lines.replace(/\r/g, ' | ').trim() };
    },
  },
  // ROS 2 via rosbridge: publish sensor_msgs/JointState on /joint_states. 0..1 → -pi..pi.
  rosbridge: {
    label: 'ROS 2 (rosbridge JointState)', binary: false,
    init() { return JSON.stringify({ op: 'advertise', topic: '/joint_states', type: 'sensor_msgs/JointState' }); },
    encode(t, opts) {
      const name = (opts && opts.names) || t.map((_, i) => 'joint' + i);
      const position = t.map((v) => -Math.PI + v * 2 * Math.PI);
      const s = JSON.stringify({ op: 'publish', topic: '/joint_states', msg: { name, position } });
      return { data: s, text: s.length > 140 ? s.slice(0, 140) + '…' : s };
    },
  },
};

// ── TRANSPORTS: how the encoded bytes leave the browser ──
// each transport handles a single payload OR an ARRAY of payloads (discrete messages, e.g. LEGO).
const eachPayload = async (d, one) => { if (Array.isArray(d)) { for (const x of d) await one(x); } else await one(d); };

const TRANSPORTS = {
  serial: {
    supported: () => typeof navigator !== 'undefined' && 'serial' in navigator,
    make() {
      let port = null, writer = null, reader = null, reading = false; const enc = new TextEncoder();
      let rxbuf = [];
      const one = async (d) => { const u = typeof d === 'string' ? enc.encode(d) : d; try { await writer.write(u); } catch (_) {} };
      // Background read pump: smart-servo buses (Feetech/Dynamixel) reply to PING/READ, so we keep a
      // reader draining into rxbuf. query() writes a frame then waits for its status reply.
      async function pump() {
        reading = true;
        try { while (reading && reader) { const { value, done } = await reader.read(); if (done) break; if (value) for (const b of value) rxbuf.push(b); } }
        catch (_) {} finally { reading = false; }
      }
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // Expected total length of a Feetech/Dynamixel-1.0 status frame from its header at `idx`:
      // FF FF ID LEN … → total = LEN + 4. Returns null if the header/len isn't in the buffer yet.
      function framedLen(buf) {
        let i = 0; while (i < buf.length - 1 && !(buf[i] === 0xFF && buf[i + 1] === 0xFF)) i++;
        if (i > buf.length - 4) return null;
        return i + 4 + buf[i + 3];
      }
      return {
        async connect(cfg) {
          port = await navigator.serial.requestPort();
          await port.open({ baudRate: (cfg && cfg.baud) || 115200 });
          writer = port.writable.getWriter();
          if (port.readable) { try { reader = port.readable.getReader(); pump(); } catch (_) {} }
        },
        connected: () => !!writer,
        send: (d) => eachPayload(d, one),
        // write a frame, then read its status reply (raw bytes) up to `timeout` ms. Protocol-agnostic:
        // the caller parses. Returns a Uint8Array (possibly empty on no reply).
        async query(d, opts) {
          rxbuf = [];
          await one(d);
          const timeout = (opts && opts.timeout) || 60, t0 = Date.now();
          while (Date.now() - t0 < timeout) {
            const need = framedLen(rxbuf);
            if (need != null && rxbuf.length >= need) return Uint8Array.from(rxbuf.slice(0, need));
            await sleep(3);
          }
          return Uint8Array.from(rxbuf);
        },
        async disconnect() {
          reading = false;
          try { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } } catch (_) {}
          try { if (writer) writer.releaseLock(); if (port) await port.close(); } catch (_) {}
          writer = null; reader = null; port = null; rxbuf = [];
        },
      };
    },
  },
  ble: {
    supported: () => typeof navigator !== 'undefined' && 'bluetooth' in navigator,
    make() {
      const NUS_SVC = '6e400001-b5a3-f393-e0a9-e50e24dcca9e', NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
      let dev = null, ch = null, withResp = false; const enc = new TextEncoder();
      const one = async (d) => { const u = typeof d === 'string' ? enc.encode(d) : d; try { for (let i = 0; i < u.length; i += 20) { const part = u.slice(i, i + 20); if (withResp) await ch.writeValueWithResponse(part); else await ch.writeValueWithoutResponse(part); } } catch (_) {} };
      return {
        async connect(cfg) {
          const b = (cfg && cfg.ble) || {}; const svc = b.service || NUS_SVC, cuid = b.char || NUS_RX; withResp = !!b.withResponse;
          dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [svc] }], optionalServices: [svc] });
          const gatt = await dev.gatt.connect(); const s = await gatt.getPrimaryService(svc); ch = await s.getCharacteristic(cuid);
        },
        connected: () => !!(dev && dev.gatt && dev.gatt.connected && ch),
        send: (d) => eachPayload(d, one),
        async disconnect() { try { if (dev && dev.gatt) dev.gatt.disconnect(); } catch (_) {} dev = null; ch = null; },
      };
    },
  },
  ws: {
    supported: () => typeof WebSocket !== 'undefined',
    make() {
      let ws = null; const enc = new TextEncoder();
      const one = async (d) => { try { ws.send(typeof d === 'string' ? d : (d instanceof Uint8Array ? d : enc.encode(JSON.stringify(d)))); } catch (_) {} };
      return {
        connect(cfg) { return new Promise((res, rej) => { try { ws = (cfg && cfg.protocol) ? new WebSocket((cfg && cfg.url) || 'ws://localhost:9090', cfg.protocol) : new WebSocket((cfg && cfg.url) || 'ws://localhost:9090'); if (cfg && cfg.protocol) ws.binaryType = 'arraybuffer'; } catch (e) { rej(e); return; } ws.onopen = () => res(); ws.onerror = () => rej(new Error('WebSocket connection failed')); }); },
        connected: () => !!ws && ws.readyState === 1,
        send: (d) => eachPayload(d, one),
        async disconnect() { try { if (ws) ws.close(); } catch (_) {} ws = null; },
      };
    },
  },
};

// ── TARGET REGISTRY: the boards / ecosystems we can drive ──
export const TARGETS = [
  { group: 'Microcontroller (Arduino-class)', id: 'arduino', label: 'Arduino (Uno/Mega/Nano/Leonardo/Due)', transport: 'serial', codec: 'pwm-text', baud: 115200, firmware: 'pwm', setup: 'Flash forge-bridge.ino, wire servo channel i → PINS[i], connect over USB.' },
  { group: 'Microcontroller (Arduino-class)', id: 'esp32', label: 'ESP32 / ESP8266 (USB)', transport: 'serial', codec: 'pwm-text', baud: 115200, firmware: 'pwm', setup: 'Flash forge-bridge.ino (Arduino-ESP32 core). For >8 servos use a PCA9685.' },
  { group: 'Microcontroller (Arduino-class)', id: 'esp32-ble', label: 'ESP32 (wireless · Bluetooth LE)', transport: 'ble', codec: 'pwm-text', firmware: 'pwm-ble', setup: 'Flash a BLE-UART (Nordic NUS) firmware; the browser streams frames wirelessly.' },
  { group: 'Microcontroller (Arduino-class)', id: 'pico', label: 'Raspberry Pi Pico / RP2040', transport: 'serial', codec: 'pwm-text', baud: 115200, firmware: 'pwm', setup: 'Flash forge-bridge.ino via the Arduino-Pico core (or a MicroPython equivalent).' },
  { group: 'Microcontroller (Arduino-class)', id: 'teensy', label: 'Teensy 3.x / 4.x', transport: 'serial', codec: 'pwm-text', baud: 115200, firmware: 'pwm', setup: 'Flash forge-bridge.ino (Teensyduino). Great for many servos + fast serial.' },
  { group: 'Microcontroller (Arduino-class)', id: 'microbit', label: 'BBC micro:bit v2 (Bluetooth LE)', transport: 'ble', codec: 'pwm-text', firmware: 'pwm-ble', setup: 'Run a MakeCode/MicroPython BLE-UART receiver that parses "#us,…" to servo writes.' },
  { group: 'Microcontroller (Arduino-class)', id: 'firmata', label: 'Firmata (any Arduino · no custom firmware)', transport: 'serial', codec: 'firmata', baud: 57600, setup: 'Flash the stock StandardFirmata (Arduino IDE → Examples → Firmata → StandardFirmata). No custom code — channel i → pin i as a servo.' },
  { group: 'Servo / motor controller (native protocol)', id: 'maestro', label: 'Pololu Maestro (6–24 ch)', transport: 'serial', codec: 'maestro', baud: 115200, setup: 'Set the Maestro serial mode to "USB Dual Port"; no firmware needed.' },
  { group: 'Servo / motor controller (native protocol)', id: 'ssc32', label: 'Lynxmotion SSC-32U', transport: 'serial', codec: 'ssc32', baud: 115200, setup: 'Connect over USB; no firmware needed.' },
  { group: 'Servo / motor controller (native protocol)', id: 'odrive', label: 'ODrive (BLDC motor controllers)', transport: 'serial', codec: 'odrive', baud: 115200, setup: 'Connect the ODrive over USB, axes in closed-loop position control. Channel i → axis i (input_pos in turns). Great for real BLDC legged robots.' },
  { group: 'Smart-servo bus (position + feedback)', id: 'feetech', label: 'Feetech STS/SMS · LeRobot SO-100/101, Waveshare ST3215', transport: 'serial', codec: 'feetech-scs', baud: 1000000, setup: 'Connect the bus USB-TTL adapter (FE-URT / Waveshare). Set servo IDs 1..N. Write-only (open loop). BETA — verify against your servo docs.' },
  { group: 'Smart-servo bus (position + feedback)', id: 'dynamixel', label: 'ROBOTIS Dynamixel X (Protocol 2.0)', transport: 'serial', codec: 'dynamixel2', baud: 1000000, setup: 'Connect a U2D2 / USB2Dynamixel. Set IDs 1..N, goal position addressing (X-series). BETA — verify against your model.' },
  { group: 'Robot kit (Bluetooth LE)', id: 'lego', label: 'LEGO SPIKE / Technic / MINDSTORMS hub', transport: 'ble', codec: 'lego', ble: { service: LEGO_SVC, char: LEGO_CHAR, withResponse: true }, setup: 'Power on a SPIKE Prime / Technic / Robot Inventor hub and pick it in the Bluetooth prompt. Channel i → port (A,B,C,D…); motors go to an absolute angle.' },
  { group: 'Servo / motor controller (native protocol)', id: 'slcan', label: 'CAN bus · ODrive (SLCAN adapter)', transport: 'serial', codec: 'slcan', baud: 115200, setup: 'Use a CANable / SLCAN USB-CAN adapter (open the channel first, e.g. `S8` 1 Mbit + `O`). Frames ODrive Set_Input_Pos on arbitration (axis<<5)|0x0C.' },
  { group: 'Ecosystem', id: 'osc', label: 'OSC (TouchDesigner / Max / SuperCollider)', transport: 'ws', codec: 'osc', url: 'ws://localhost:8080', setup: 'Run an OSC-over-WebSocket bridge (e.g. an osc-js relay). Sends /forge/joints with a float per joint.' },
  { group: 'Ecosystem', id: 'ros2', label: 'ROS 2 (rosbridge · JointState)', transport: 'ws', codec: 'rosbridge', url: 'ws://localhost:9090', setup: 'Run rosbridge_server (ros2 launch rosbridge_server rosbridge_websocket_launch.xml). Streams sensor_msgs/JointState on /joint_states.' },
  { group: 'Ecosystem', id: 'mqtt', label: 'MQTT (Home Assistant / ESPHome / IoT)', transport: 'ws', codec: 'mqtt', url: 'ws://localhost:9001', protocol: 'mqtt', setup: 'Point at your broker’s WebSocket listener (e.g. Mosquitto: listener 9001 + protocol websockets). Publishes a joint array to forge/joints.' },
];

export function hwSupportedAny() {
  return TARGETS.some((t) => TRANSPORTS[t.transport] && TRANSPORTS[t.transport].supported());
}

export function makeBridge() {
  let target = TARGETS[0], tx = null;
  return {
    targets: () => TARGETS,
    setTarget(id) { const found = TARGETS.find((t) => t.id === id); if (found) target = found; return target; },
    getTarget: () => target,
    transportSupported: () => !!(TRANSPORTS[target.transport] && TRANSPORTS[target.transport].supported()),
    connected: () => !!tx && tx.connected(),
    async connect(cfg) {
      const T = TRANSPORTS[target.transport];
      if (!T || !T.supported()) throw new Error(target.transport + ' is not available in this browser.');
      tx = T.make();
      await tx.connect({ baud: target.baud, url: (cfg && cfg.url) || target.url, protocol: target.protocol, ble: target.ble });
      const codec = CODECS[target.codec];
      if (codec.init) { try { await tx.send(codec.init({ channels: cfg && cfg.channels })); } catch (_) {} } // rosbridge advertise · Firmata pin modes · MQTT connect
      return true;
    },
    // encode current actuator commands with the target's codec and push them out. Returns the
    // monitor text (or null if not connected). ctrl+ranges → normalized → codec → transport.
    async send(ctrl, ranges, opts) {
      if (!tx || !tx.connected()) return null;
      const t = normalize(ctrl, ranges);
      const { data, text } = CODECS[target.codec].encode(t, opts || {});
      await tx.send(data);
      return text;
    },
    async disconnect() { try { if (tx) await tx.disconnect(); } catch (_) {} tx = null; },
    // Expose the connected transport as an io object for request/response protocol layers
    // (the Feetech SO-101 bring-up: scan/read servos, then stream calibrated goals). query() is
    // only present on the serial transport; falls back to an empty reply elsewhere.
    hwio(statusCb) {
      return {
        send: (bytes) => (tx ? tx.send(bytes) : Promise.resolve()),
        query: (bytes, opts) => (tx && tx.query ? tx.query(bytes, opts) : Promise.resolve(new Uint8Array())),
        status: statusCb || (() => {}),
      };
    },
  };
}

// Back-compat pure encoder (the original PWM path) + a direct-callable alias for tests.
export function encodeFrame(ctrl, ranges) { return CODECS['pwm-text'].encode(normalize(ctrl, ranges)).data; }
export function hwSupported() { return TRANSPORTS.serial.supported(); }
export { crc16 };

// The PWM receiver firmware (Arduino / ESP32 / Pico / Teensy). USB-serial variant.
export function firmwareSketch() {
  return `// Forge → hardware bridge receiver (Arduino / ESP32 / Pico / Teensy)
// Reads "#us0,us1,...\\n" over USB serial at 115200 and writes each microsecond value to a
// servo. Wire servo channel i (per the Forge servo map) to PINS[i].
#include <Servo.h>

const int PINS[] = {2, 3, 4, 5, 6, 7, 8, 9};   // add pins for more channels; a quadruped uses 8
const int N = sizeof(PINS) / sizeof(PINS[0]);
Servo servos[N];
char buf[192];
int len = 0;

void apply(char* line) {
  if (line[0] != '#') return;
  char* p = line + 1;
  int ch = 0;
  while (*p && ch < N) {
    int us = atoi(p);
    if (us >= 500 && us <= 2500) servos[ch].writeMicroseconds(us);
    ch++;
    char* comma = strchr(p, ',');
    if (!comma) break;
    p = comma + 1;
  }
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < N; i++) servos[i].attach(PINS[i]);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\\n') { buf[len] = 0; apply(buf); len = 0; }
    else if (len < 191) buf[len++] = c;
  }
}
`;
}
