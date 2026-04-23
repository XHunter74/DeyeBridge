import ModbusRTU from 'modbus-serial';

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

async function readRegisters(
  client: ModbusRTU,
  docStartAddress: number,
  length: number,
  addressOffset: number,
): Promise<number[]> {
  const actualStartAddress = toModbusAddress(docStartAddress, addressOffset);
  const response = await client.readHoldingRegisters(actualStartAddress, length);
  return response.data;
}

async function main(): Promise<void> {
  const config = readConfig();
  const client = new ModbusRTU();

  console.log('Connecting to Deye...');
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
    await client.connectTCP(config.host, { port: config.port });
    client.setID(config.unitId);
    client.setTimeout(config.timeoutMs);

    // Read one continuous block: 248..279 => 32 registers
    const registers = await readRegisters(
      client,
      TOU_ENABLE_REGISTER,
      32,
      config.addressOffset,
    );

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
    console.error('- Check DEYE_HOST / DEYE_PORT / DEYE_UNIT_ID');
    console.error('- Many Deye gateways use Modbus TCP port 8899');
    console.error('- If all values look shifted or empty, try DEYE_ADDRESS_OFFSET=1');
    process.exitCode = 1;
  } finally {
    try {
      client.close(() => undefined);
    } catch {
      // ignore close errors
    }
  }
}

void main();
