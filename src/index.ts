import * as net from 'node:net';

const DEBUG = process.env.DEYE_DEBUG === '1';
function hexDump(label: string, buf: Buffer): void {
  if (!DEBUG) return;
  const hex = [...buf].map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.error(`[debug] ${label} (${buf.length}B): ${hex}`);
}

type TimeSlot = {
  index: number;
  startTime: string;
  endTime: string;  // derived: start time of the next slot (wraps from last to first)
  powerW: number;
  capacityPercent: number;
  gridCharge: boolean;
  genCharge: boolean;
};

type Config = {
  host: string;
  port: number;
  unitId: number;
  timeoutMs: number;
  addressOffset: number;
  loggerSn: number;
};

const TOU_ENABLE_REGISTER = 248;
// Register 249 is reserved.
const TOU_START_TIME_REGISTER = 250;    // 6 registers: sell mode time points (HHMM, 0000-2359)
const TOU_POWER_REGISTER = 256;         // 6 registers: sell mode power per time point (W)
const TOU_VOLTAGE_REGISTER = 262;       // 6 registers: sell mode battery voltage target (0.01V)
const TOU_CAPACITY_REGISTER = 268;      // 6 registers: capacity / SOC target (%)
const TOU_CHARGE_ENABLE_REGISTER = 274; // 6 registers: bitmask (bit0=grid, bit1=gen, bit2=GM, bit3=BU, bit4=CH)
// End time is not a separate register — it equals the start time of the next slot.
const TOU_SLOT_COUNT = 6;

function getEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number. Received: ${raw}`);
  }

  return parsed;
}

function readConfig(): Config {
  return {
    host: process.env.DEYE_HOST || '192.178.10.30',
    port: getEnvNumber('DEYE_PORT', 8899),
    unitId: getEnvNumber('DEYE_UNIT_ID', 1),
    timeoutMs: getEnvNumber('DEYE_TIMEOUT_MS', 5000),
    addressOffset: getEnvNumber('DEYE_ADDRESS_OFFSET', 0),
    loggerSn: getEnvNumber('DEYE_LOGGER_SN', 3597524762),
  };
}

function toModbusAddress(docAddress: number, offset: number): number {
  return docAddress + offset;
}

function formatDocAddress(docAddress: number, offset: number): string {
  const actual = toModbusAddress(docAddress, offset);
  return offset === 0
    ? `${docAddress}`
    : `${docAddress} (document) -> ${actual} (actual request address)`;
}

function decodeTime(raw: number): string {
  const hours = Math.floor(raw / 100);
  const minutes = raw % 100;

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return `INVALID(${raw})`;
  }

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

function decodeChargeEnable(raw: number) {
  return {
    gridCharge: (raw & 0b00001) !== 0,
    genCharge:  (raw & 0b00010) !== 0,
  };
}

function buildSlots(registers: number[]): TimeSlot[] {
  // registers[0..5]   = 250..255  start times (HHMM)
  // registers[6..11]  = 256..261  power (W)
  // registers[12..17] = 262..267  voltage (0.01V, unused)
  // registers[18..23] = 268..273  capacity (%)
  // registers[24..29] = 274..279  charge enable bitmask
  // End time is derived: endTime[i] = startTime[i+1]; last slot wraps to startTime[0]
  const startTimeWords    = registers.slice(0,                  TOU_SLOT_COUNT);
  const powerWords        = registers.slice(TOU_SLOT_COUNT,     TOU_SLOT_COUNT * 2);
  const capacityWords     = registers.slice(TOU_SLOT_COUNT * 3, TOU_SLOT_COUNT * 4);
  const chargeEnableWords = registers.slice(TOU_SLOT_COUNT * 4, TOU_SLOT_COUNT * 5);

  return Array.from({ length: TOU_SLOT_COUNT }, (_, i) => {
    const flags = decodeChargeEnable(chargeEnableWords[i]);
    return {
      index: i + 1,
      startTime: decodeTime(startTimeWords[i]),
      endTime: decodeTime(startTimeWords[(i + 1) % TOU_SLOT_COUNT]),
      powerW: powerWords[i],
      capacityPercent: capacityWords[i],
      gridCharge: flags.gridCharge,
      genCharge: flags.genCharge,
    };
  });
}

// ---------------------------------------------------------------------------
// SolarmanV5 protocol
// Port 8899 on Deye inverters is NOT plain Modbus TCP. It speaks SolarmanV5:
// each Modbus RTU frame is wrapped in a proprietary envelope that includes the
// data-logger's serial number.  Plain Modbus TCP (MBAP header) is silently
// ignored, which causes the timeout we were seeing.
// Reference: https://pysolarmanv5.readthedocs.io/en/latest/solarmanv5_protocol.html
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

// Checksum covers all bytes between start (0xa5) and the checksum byte itself.
// Pass the FULL frame buffer; the function sums indices 1 through length-3.
function solarmanChecksum(buf: Buffer): number {
  let sum = 0;
  for (let i = 1; i < buf.length - 2; i++) sum += buf[i] & 0xff;
  return sum & 0xff;
}

function buildModbusRtuReadRequest(unitId: number, startAddr: number, count: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt8(unitId, 0);
  buf.writeUInt8(0x03, 1);           // FC03 Read Holding Registers
  buf.writeUInt16BE(startAddr, 2);
  buf.writeUInt16BE(count, 4);
  buf.writeUInt16LE(modbusRtuCrc(buf.subarray(0, 6)), 6);
  return buf;
}

function buildSolarmanV5Frame(loggerSn: number, seq: number, modbusRtu: Buffer): Buffer {
  // Request payload (15 bytes):
  //   frameType    (1 byte)  = 0x02
  //   sensorType   (2 bytes) = 0x0000
  //   totalWorkingTime (4 bytes) = 0x00000000  (pysolarmanv5 sends zeros)
  //   powerOnTime  (4 bytes) = 0x00000000
  //   offsetTime   (4 bytes) = 0x00000000
  // then Modbus RTU frame
  const PAYLOAD_HDR = 15;
  const total = 11 + PAYLOAD_HDR + modbusRtu.length + 2;
  const buf = Buffer.alloc(total, 0); // all zeros by default

  buf.writeUInt8(0xa5, 0);                              // Start
  buf.writeUInt16LE(PAYLOAD_HDR + modbusRtu.length, 1); // Length
  buf.writeUInt16LE(0x4510, 3);                         // Control code REQUEST
  buf.writeUInt8(seq & 0xff, 5);                        // Sequence (first byte)
  buf.writeUInt8(0x00, 6);                              // Sequence (second byte)
  buf.writeUInt32LE(loggerSn >>> 0, 7);                 // Logger serial number

  buf.writeUInt8(0x02, 11);                             // Frame type: solar inverter
  // sensorType (2 bytes) = 0x0000 — stays zero
  // totalWorkingTime (4 bytes): send current epoch seconds (some loggers require non-zero)
  buf.writeUInt32LE(Math.floor(Date.now() / 1000), 14);
  // powerOnTime and offsetTime remain 0x00

  modbusRtu.copy(buf, 26);                              // 11 + 15 = 26

  // Checksum: sum of bytes 1..total-3 (full buffer passed so length-2 gives the right bound)
  buf.writeUInt8(solarmanChecksum(buf), total - 2);
  buf.writeUInt8(0x15, total - 1);                      // End

  return buf;
}

// Scan accumulated TCP data for a complete, valid SolarmanV5 response frame
// and extract the Modbus holding-register values from it.
function tryExtractRegisters(data: Buffer): number[] | null {
  for (let s = 0; s <= data.length - 3; s++) {
    if (data[s] !== 0xa5) continue;

    const payloadLen = data.readUInt16LE(s + 1);
    const frameLen = 11 + payloadLen + 2;
    if (data.length < s + frameLen) continue;            // incomplete – keep buffering

    const f = data.subarray(s, s + frameLen);
    if (f[frameLen - 1] !== 0x15) continue;              // bad end byte

    const ctrlCode = f.readUInt16LE(3);                  // LE: 0x1510 or 0x4510
    if (ctrlCode !== 0x1510 && ctrlCode !== 0x4510) continue;

    // Response payload header = 14 bytes (offset 11..24); Modbus RTU starts at 25
    // Layout: frameType(1) status(1) totalWorkingTime(4) powerOnTime(4) offsetTime(4)
    // f[25] = Modbus unit ID
    // f[26] = Modbus function code
    // f[27] = Modbus byte count
    // f[28..] = register data
    const unitId   = f[25];
    const funcCode = f[26];
    if (funcCode === 0x83) throw new Error(`Modbus exception FC03 from unit ${unitId}`);
    if (funcCode !== 0x03) continue;

    const byteCount = f[27];
    // Deye known bug: Modbus CRC is appended twice (extra 2 zero bytes).
    // The declared payloadLen covers both cases; we just read byteCount bytes.
    if (f.length < s + 28 + byteCount) continue;        // incomplete

    const registers: number[] = [];
    for (let i = 0; i < byteCount; i += 2) {
      registers.push(f.readUInt16BE(28 + i));
    }
    return registers;
  }
  return null;
}

async function readRegisters(
  config: Config,
  docStartAddress: number,
  count: number,
): Promise<number[]> {
  const actualAddress = toModbusAddress(docStartAddress, config.addressOffset);
  const modbusRtu = buildModbusRtuReadRequest(config.unitId, actualAddress, count);
  const frame = buildSolarmanV5Frame(config.loggerSn, 0x01, modbusRtu);
  hexDump('TX', frame);

  return new Promise<number[]>((resolve, reject) => {
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
      settle(() => {
        const err = Object.assign(new Error('Timed out'), {
          name: 'TransactionTimedOutError',
          errno: 'ETIMEDOUT',
        });
        reject(err);
      });
    }, config.timeoutMs);

    socket.connect(config.port, config.host, () => {
      socket.write(frame);
    });

    socket.on('data', (chunk: Buffer) => {
      hexDump('RX', chunk);
      chunks.push(chunk);
      try {
        const registers = tryExtractRegisters(Buffer.concat(chunks));
        if (registers !== null) settle(() => resolve(registers));
      } catch (err) {
        settle(() => reject(err));
      }
    });

    socket.on('error', (err: Error) => {
      settle(() => reject(err));
    });

    socket.on('close', () => {
      if (!settled) {
        const received = Buffer.concat(chunks);
        if (received.length > 0) hexDump('RX-on-close (unparsed)', received);
        settle(() => reject(new Error('Connection closed before a complete response was received')));
      }
    });
  });
}

async function main(): Promise<void> {
  const config = readConfig();

  if (config.loggerSn === 0) {
    console.error('Error: DEYE_LOGGER_SN is not set.');
    console.error('');
    console.error('The Solarman WiFi data-logger serial number is required for the');
    console.error('SolarmanV5 protocol used on port 8899.  Find it on the sticker');
    console.error('on the WiFi dongle plugged into the inverter (e.g. 2712345678).');
    console.error('');
    console.error('Set it before running:');
    console.error('  $env:DEYE_LOGGER_SN="2712345678"; npm run dev');
    process.exitCode = 1;
    return;
  }

  console.log('Connecting to Deye (SolarmanV5 protocol)...');
  console.log(JSON.stringify(config, null, 2));
  console.log('');
  console.log('Expected document addresses:');
  console.log(`- TOU enable:     ${formatDocAddress(TOU_ENABLE_REGISTER, config.addressOffset)}`);
  console.log(`- TOU start time: ${formatDocAddress(TOU_START_TIME_REGISTER, config.addressOffset)}..${formatDocAddress(TOU_START_TIME_REGISTER + 5, config.addressOffset)} (end time = next slot start)`);
  console.log(`- TOU power:      ${formatDocAddress(TOU_POWER_REGISTER, config.addressOffset)}..${formatDocAddress(TOU_POWER_REGISTER + 5, config.addressOffset)}`);
  console.log(`- TOU voltage:    ${formatDocAddress(TOU_VOLTAGE_REGISTER, config.addressOffset)}..${formatDocAddress(TOU_VOLTAGE_REGISTER + 5, config.addressOffset)}`);
  console.log(`- TOU capacity:   ${formatDocAddress(TOU_CAPACITY_REGISTER, config.addressOffset)}..${formatDocAddress(TOU_CAPACITY_REGISTER + 5, config.addressOffset)}`);
  console.log(`- Charge enable:  ${formatDocAddress(TOU_CHARGE_ENABLE_REGISTER, config.addressOffset)}..${formatDocAddress(TOU_CHARGE_ENABLE_REGISTER + 5, config.addressOffset)}`);
  console.log('');

  try {
    // Read registers 248..279 = 32 registers.
    // [0]     = reg 248  global TOU enable
    // [1]     = reg 249  reserved
    // [2..31] = reg 250..279  slot data (start time, power, voltage, capacity, charge enable)
    //           End time is derived: endTime[i] = startTime[i+1], last slot wraps to startTime[0]
    const registers = await readRegisters(config, TOU_ENABLE_REGISTER, 32);

    const slots = buildSlots(registers.slice(2)); // reg248=globalEnable, reg249=gap, reg250+=slot data

    console.table(
      slots.map((slot) => ({
        slot: slot.index,
        startTime: slot.startTime,
        endTime: slot.endTime,
        powerW: slot.powerW,
        capacityPercent: slot.capacityPercent,
        gridCharge: slot.gridCharge,
        genCharge: slot.genCharge,
      })),
    );
  } catch (error) {
    console.error('Failed to read Deye Time of Use data.');
    console.error(error);
    console.error('');
    console.error('Tips:');
    console.error('- Check DEYE_HOST / DEYE_PORT / DEYE_UNIT_ID / DEYE_LOGGER_SN');
    console.error('- Port 8899 uses SolarmanV5 protocol (logger SN required)');
    console.error('- If all values look shifted or empty, try DEYE_ADDRESS_OFFSET=1');
    process.exitCode = 1;
  }
}

void main();
