import * as net from 'node:net';

type TimeSlot = {
  index: number;
  enabled: boolean;
  gridChargeEnabled: boolean;
  generatorChargeEnabled: boolean;
  gmMode: boolean;
  buMode: boolean;
  chMode: boolean;
  time: string;
  powerW: number;
  voltageV: number;
  capacityPercent: number;
  raw: {
    enable: number;
    time: number;
    power: number;
    voltage: number;
    capacity: number;
  };
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
const TOU_TIME_START_REGISTER = 250;
const TOU_POWER_START_REGISTER = 256;
const TOU_VOLTAGE_START_REGISTER = 262;
const TOU_CAPACITY_START_REGISTER = 268;
const TOU_CHARGE_ENABLE_START_REGISTER = 274;
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
    enabled: raw !== 0,
    gridChargeEnabled: (raw & 0b00001) !== 0,
    generatorChargeEnabled: (raw & 0b00010) !== 0,
    gmMode: (raw & 0b00100) !== 0,
    buMode: (raw & 0b01000) !== 0,
    chMode: (raw & 0b10000) !== 0,
  };
}

function buildSlots(registers: number[]): TimeSlot[] {
  const enableWords = registers.slice(0, TOU_SLOT_COUNT);
  const timeWords = registers.slice(TOU_SLOT_COUNT, TOU_SLOT_COUNT * 2);
  const powerWords = registers.slice(TOU_SLOT_COUNT * 2, TOU_SLOT_COUNT * 3);
  const voltageWords = registers.slice(TOU_SLOT_COUNT * 3, TOU_SLOT_COUNT * 4);
  const capacityWords = registers.slice(TOU_SLOT_COUNT * 4, TOU_SLOT_COUNT * 5);
  const chargeEnableWords = registers.slice(TOU_SLOT_COUNT * 5, TOU_SLOT_COUNT * 6);

  return Array.from({ length: TOU_SLOT_COUNT }, (_, i) => {
    const flags = decodeChargeEnable(chargeEnableWords[i]);

    return {
      index: i + 1,
      enabled: flags.enabled,
      gridChargeEnabled: flags.gridChargeEnabled,
      generatorChargeEnabled: flags.generatorChargeEnabled,
      gmMode: flags.gmMode,
      buMode: flags.buMode,
      chMode: flags.chMode,
      time: decodeTime(timeWords[i]),
      powerW: powerWords[i],
      voltageV: voltageWords[i] / 100,
      capacityPercent: capacityWords[i],
      raw: {
        enable: enableWords[i],
        time: timeWords[i],
        power: powerWords[i],
        voltage: voltageWords[i],
        capacity: capacityWords[i],
      },
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
  // Frame layout (total = 11 header + 15 payload-header + modbusRtu.length + 2 trailer):
  //  [0xa5][len LE2][0x10 0x45][seq][0x00][SN LE4]   <- 11-byte header
  //  [0x02][0x00][timestamp LE4][0 LE4][0 LE4][0x00]  <- 15-byte payload header
  //  [Modbus RTU frame]                                <- variable
  //  [checksum][0x15]                                  <- 2-byte trailer
  const PAYLOAD_HDR = 15;
  const total = 11 + PAYLOAD_HDR + modbusRtu.length + 2;
  const buf = Buffer.alloc(total, 0);

  buf.writeUInt8(0xa5, 0);
  buf.writeUInt16LE(PAYLOAD_HDR + modbusRtu.length, 1);
  buf.writeUInt16LE(0x4510, 3);                         // control code: request
  buf.writeUInt8(seq & 0xff, 5);
  buf.writeUInt8(0x00, 6);
  buf.writeUInt32LE(loggerSn >>> 0, 7);                 // logger serial number

  buf.writeUInt8(0x02, 11);                              // frame type: inverter
  buf.writeUInt32LE(Math.floor(Date.now() / 1000), 13); // delivery timestamp

  modbusRtu.copy(buf, 26);

  buf.writeUInt8(solarmanChecksum(buf.subarray(0, total - 2)), total - 2);
  buf.writeUInt8(0x15, total - 1);

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
    if (f[frameLen - 1] !== 0x15) continue;             // bad end byte

    const ctrlCode = f.readUInt16BE(3);                  // response codes: 0x1015 or 0x1045
    if (ctrlCode !== 0x1015 && ctrlCode !== 0x1045) continue;

    // Response payload header = 14 bytes (offset 11..24); Modbus RTU starts at offset 25
    const funcCode = f[26];
    if (funcCode === 0x83) throw new Error('Modbus exception on FC03 (illegal address or gateway timeout)');
    if (funcCode !== 0x03) continue;

    const byteCount = f[27];
    if (frameLen < 28 + byteCount + 4) continue;        // incomplete Modbus data

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
  console.log(`- TOU times:      ${formatDocAddress(TOU_TIME_START_REGISTER, config.addressOffset)}..${formatDocAddress(TOU_TIME_START_REGISTER + 5, config.addressOffset)}`);
  console.log(`- TOU power:      ${formatDocAddress(TOU_POWER_START_REGISTER, config.addressOffset)}..${formatDocAddress(TOU_POWER_START_REGISTER + 5, config.addressOffset)}`);
  console.log(`- TOU voltage:    ${formatDocAddress(TOU_VOLTAGE_START_REGISTER, config.addressOffset)}..${formatDocAddress(TOU_VOLTAGE_START_REGISTER + 5, config.addressOffset)}`);
  console.log(`- TOU capacity:   ${formatDocAddress(TOU_CAPACITY_START_REGISTER, config.addressOffset)}..${formatDocAddress(TOU_CAPACITY_START_REGISTER + 5, config.addressOffset)}`);
  console.log(`- Charge enable:  ${formatDocAddress(TOU_CHARGE_ENABLE_START_REGISTER, config.addressOffset)}..${formatDocAddress(TOU_CHARGE_ENABLE_START_REGISTER + 5, config.addressOffset)}`);
  console.log('');

  try {
    // Read one continuous block: registers 248..279 = 32 registers
    const registers = await readRegisters(config, TOU_ENABLE_REGISTER, 32);

    const globalTouEnable = registers[0];
    const slots = buildSlots(registers.slice(1, 31 + 1));

    console.log(`Global TOU flags (register ${TOU_ENABLE_REGISTER}): ${globalTouEnable}`);
    console.log('');
    console.table(
      slots.map((slot) => ({
        slot: slot.index,
        enabled: slot.enabled,
        time: slot.time,
        powerW: slot.powerW,
        voltageV: slot.voltageV,
        capacityPercent: slot.capacityPercent,
        gridCharge: slot.gridChargeEnabled,
        generatorCharge: slot.generatorChargeEnabled,
        gmMode: slot.gmMode,
        buMode: slot.buMode,
        chMode: slot.chMode,
      })),
    );

    console.log('\nRaw slot data:');
    console.log(JSON.stringify(slots, null, 2));
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
