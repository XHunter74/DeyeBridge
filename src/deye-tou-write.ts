// Deye inverter — Time of Use write script for ioBroker.javascript adapter.
// Paste this script into the ioBroker.javascript TypeScript editor.
//
// Usage example:
//   const config: TouConfig = {
//     host: '192.168.1.100', port: 8899, unitId: 1,
//     timeoutMs: 5000, addressOffset: 0, loggerSn: 1234567890,
//   };
//   const slots = validateTimeOfUse(JSON.parse(getState('deye.0.tou_json').val as string));
//   writeTimeOfUse(config, slots)
//     .then(() => log('TOU written successfully'))
//     .catch(err => log('TOU write failed: ' + err.message, 'error'));

const net = require('net') as typeof import('net');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TimeSlotInput = {
  index: number;           // 1–6
  startTime: string;       // "HH:MM"
  endTime: string;         // "HH:MM" – validated for consistency, not sent to device
  powerW: number;          // watts, 0–8000
  capacityPercent: number; // %, 0–100
  gridCharge: boolean;
  genCharge: boolean;
};

type TouConfig = {
  host: string;
  port: number;        // 8899 for SolarmanV5
  unitId: number;      // Modbus unit ID (usually 1)
  timeoutMs: number;   // socket timeout
  addressOffset: number;
  loggerSn: number;    // Solarman WiFi data-logger serial number
};

// ---------------------------------------------------------------------------
// Register constants
// ---------------------------------------------------------------------------

const TOU_START_TIME_REGISTER = 250; // 6 registers: HHMM (0000–2359)
const TOU_CAPACITY_REGISTER   = 268; // 6 registers: % SOC target
const TOU_SLOT_COUNT          = 6;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function encodeTime(hhmm: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) throw new Error(`Invalid time format "${hhmm}": expected HH:MM`);
  const hours   = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours > 23 || minutes > 59)
    throw new Error(`Invalid time value "${hhmm}": hours must be 0–23, minutes 0–59`);
  return hours * 100 + minutes;
}

function isValidTime(hhmm: string): boolean {
  try { encodeTime(hhmm); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateTimeOfUse(input: unknown): TimeSlotInput[] {
  if (!Array.isArray(input))
    throw new Error('TOU input must be an array');
  if (input.length !== TOU_SLOT_COUNT)
    throw new Error(`Expected exactly ${TOU_SLOT_COUNT} slots, got ${input.length}`);

  // Per-slot structural validation
  const seenIndexes = new Set<number>();
  for (let i = 0; i < input.length; i++) {
    const s = input[i] as Record<string, unknown>;
    const label = `Slot at position ${i + 1}`;

    if (typeof s !== 'object' || s === null)
      throw new Error(`${label}: must be an object`);

    // index
    if (!Number.isInteger(s['index']) || (s['index'] as number) < 1 || (s['index'] as number) > 6)
      throw new Error(`${label}: index must be an integer 1–6, got ${JSON.stringify(s['index'])}`);
    if (seenIndexes.has(s['index'] as number))
      throw new Error(`Duplicate slot index ${s['index']}`);
    seenIndexes.add(s['index'] as number);

    // times
    if (typeof s['startTime'] !== 'string' || !isValidTime(s['startTime'] as string))
      throw new Error(`${label} (index ${s['index']}): invalid startTime "${s['startTime']}"`);
    if (typeof s['endTime'] !== 'string' || !isValidTime(s['endTime'] as string))
      throw new Error(`${label} (index ${s['index']}): invalid endTime "${s['endTime']}"`);

    // powerW
    if (typeof s['powerW'] !== 'number' || s['powerW'] < 0 || s['powerW'] > 8000)
      throw new Error(`${label} (index ${s['index']}): powerW ${s['powerW']} out of range [0, 8000]`);

    // capacityPercent
    if (typeof s['capacityPercent'] !== 'number' || s['capacityPercent'] < 0 || s['capacityPercent'] > 100)
      throw new Error(`${label} (index ${s['index']}): capacityPercent ${s['capacityPercent']} out of range [0, 100]`);

    // booleans
    if (typeof s['gridCharge'] !== 'boolean')
      throw new Error(`${label} (index ${s['index']}): gridCharge must be boolean`);
    if (typeof s['genCharge'] !== 'boolean')
      throw new Error(`${label} (index ${s['index']}): genCharge must be boolean`);
  }

  // Sort by index for order checks
  const slots = [...input].sort(
    (a, b) => (a as TimeSlotInput).index - (b as TimeSlotInput).index,
  ) as TimeSlotInput[];

  // Slot 1 must start at midnight
  if (slots[0].startTime !== '00:00')
    throw new Error(`Slot 1 startTime must be "00:00", got "${slots[0].startTime}"`);

  // startTimes must be strictly ascending; endTime must match next slot's startTime
  for (let i = 0; i < TOU_SLOT_COUNT; i++) {
    const curr = slots[i];
    const next = slots[(i + 1) % TOU_SLOT_COUNT];

    if (i > 0 && encodeTime(curr.startTime) <= encodeTime(slots[i - 1].startTime))
      throw new Error(
        `Slot ${curr.index} startTime "${curr.startTime}" must be later than ` +
        `slot ${slots[i - 1].index} startTime "${slots[i - 1].startTime}"`,
      );

    const expectedEnd = i < TOU_SLOT_COUNT - 1 ? next.startTime : '00:00';
    if (curr.endTime !== expectedEnd)
      throw new Error(
        `Slot ${curr.index} endTime "${curr.endTime}" must equal ` +
        (i < TOU_SLOT_COUNT - 1
          ? `slot ${next.index} startTime "${expectedEnd}"`
          : `"00:00" (midnight wrap)`),
      );
  }

  return slots;
}

// ---------------------------------------------------------------------------
// SolarmanV5 protocol helpers (ported from deye-bridge index.ts)
// ---------------------------------------------------------------------------

function modbusRtuCrc(buf: Buffer): number {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      const bit = crc & 0x0001;
      crc >>>= 1;
      if (bit) crc ^= 0xa001;
    }
  }
  return crc;
}

function solarmanChecksum(buf: Buffer): number {
  let sum = 0;
  for (let i = 1; i < buf.length - 2; i++) sum += buf[i] & 0xff;
  return sum & 0xff;
}

function buildModbusRtuWriteRequest(unitId: number, startAddr: number, values: number[]): Buffer {
  const byteCount = values.length * 2;
  const buf = Buffer.alloc(9 + byteCount);
  buf.writeUInt8(unitId, 0);
  buf.writeUInt8(0x10, 1);
  buf.writeUInt16BE(startAddr, 2);
  buf.writeUInt16BE(values.length, 4);
  buf.writeUInt8(byteCount, 6);
  for (let i = 0; i < values.length; i++) buf.writeUInt16BE(values[i], 7 + i * 2);
  buf.writeUInt16LE(modbusRtuCrc(buf.subarray(0, 7 + byteCount)), 7 + byteCount);
  return buf;
}

function buildSolarmanV5Frame(loggerSn: number, seq: number, modbusRtu: Buffer): Buffer {
  const PAYLOAD_HDR = 15;
  const total = 11 + PAYLOAD_HDR + modbusRtu.length + 2;
  const buf = Buffer.alloc(total, 0);
  buf.writeUInt8(0xa5, 0);
  buf.writeUInt16LE(PAYLOAD_HDR + modbusRtu.length, 1);
  buf.writeUInt16LE(0x4510, 3);
  buf.writeUInt8(seq & 0xff, 5);
  buf.writeUInt8(0x00, 6);
  buf.writeUInt32LE(loggerSn >>> 0, 7);
  buf.writeUInt8(0x02, 11);
  buf.writeUInt32LE(Math.floor(Date.now() / 1000), 14);
  modbusRtu.copy(buf, 26);
  buf.writeUInt8(solarmanChecksum(buf), total - 2);
  buf.writeUInt8(0x15, total - 1);
  return buf;
}

function tryExtractWriteAck(data: Buffer): boolean | null {
  for (let s = 0; s <= data.length - 3; s++) {
    if (data[s] !== 0xa5) continue;
    const payloadLen = data.readUInt16LE(s + 1);
    const frameLen = 11 + payloadLen + 2;
    if (data.length < s + frameLen) continue;
    const f = data.subarray(s, s + frameLen);
    if (f[frameLen - 1] !== 0x15) continue;
    const ctrlCode = f.readUInt16LE(3);
    if (ctrlCode !== 0x1510 && ctrlCode !== 0x4510) continue;
    const unitId = f[25];
    const funcCode = f[26];
    if (funcCode === 0x90) throw new Error(`Modbus exception on FC16 write from unit ${unitId}`);
    if (funcCode !== 0x10) continue;
    return true;
  }
  return null;
}

async function writeRegisters(
  config: TouConfig,
  docStartAddress: number,
  values: number[],
): Promise<void> {
  const actualAddress = docStartAddress + config.addressOffset;
  const modbusRtu = buildModbusRtuWriteRequest(config.unitId, actualAddress, values);
  const frame = buildSolarmanV5Frame(config.loggerSn, 0x01, modbusRtu);

  return new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    const chunks: Buffer[] = [];
    let settled = false;

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    }

    const timer = setTimeout(() => {
      settle(() => reject(Object.assign(new Error('Timed out waiting for write ack'), { name: 'TransactionTimedOutError' })));
    }, config.timeoutMs);

    socket.connect(config.port, config.host, () => { socket.write(frame); });

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      try {
        const ack = tryExtractWriteAck(Buffer.concat(chunks));
        if (ack !== null) settle(() => resolve());
      } catch (err) {
        settle(() => reject(err));
      }
    });

    socket.on('error', (err: Error) => { settle(() => reject(err)); });

    socket.on('close', () => {
      if (!settled)
        settle(() => reject(new Error('Connection closed before write acknowledgement')));
    });
  });
}

// ---------------------------------------------------------------------------
// Main write function
// ---------------------------------------------------------------------------

// Writes all 6 TOU slots to the Deye inverter.
// Issues two FC16 Modbus writes:
//   1. Registers 250–261: start times + power
//   2. Registers 268–279: capacity + charge enable
// Registers 262–267 (sell-mode voltage) are left untouched.
async function writeTimeOfUse(config: TouConfig, slots: TimeSlotInput[]): Promise<void> {
  const sorted = validateTimeOfUse(slots); // re-validates and sorts by index

  const startTimeValues    = sorted.map(s => encodeTime(s.startTime));
  const powerValues        = sorted.map(s => s.powerW);
  const capacityValues     = sorted.map(s => s.capacityPercent);
  const chargeEnableValues = sorted.map(s => (s.gridCharge ? 0b001 : 0) | (s.genCharge ? 0b010 : 0));

  await writeRegisters(config, TOU_START_TIME_REGISTER, [...startTimeValues, ...powerValues]);
  await writeRegisters(config, TOU_CAPACITY_REGISTER,   [...capacityValues, ...chargeEnableValues]);
}
