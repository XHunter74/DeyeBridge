# Deye Time of Use test app

Small Node.js + TypeScript test project that connects to a Deye inverter over Modbus TCP and reads Time of Use registers.

## What it reads

The script reads one continuous holding-register block from `248` to `279` and decodes:

- register `248`: global Time of Use flags
- registers `250-255`: time points (`HHmm`)
- registers `256-261`: power setpoints in watts
- registers `262-267`: voltage thresholds in `0.01V`
- registers `268-273`: capacity thresholds in `%`
- registers `274-279`: charge-enable bit flags

## Requirements

- Node.js 20+
- network access to the Deye logger / inverter
- Modbus TCP enabled

## Install

```bash
npm install
```

## Run in dev mode

```bash
npm run dev
```

## Build and run

```bash
npm run build
npm start
```

## Environment variables

```bash
DEYE_HOST=192.168.1.100
DEYE_PORT=8899
DEYE_UNIT_ID=1
DEYE_TIMEOUT_MS=5000
DEYE_ADDRESS_OFFSET=0
```

### Notes

- `DEYE_ADDRESS_OFFSET=0` uses document addresses as-is.
- If returned values look shifted, try `DEYE_ADDRESS_OFFSET=1`.
- Many Deye LAN/Wi‑Fi loggers use port `8899`.

## Example

Linux/macOS:

```bash
DEYE_HOST=192.168.1.50 DEYE_PORT=8899 DEYE_UNIT_ID=1 npm run dev
```

PowerShell:

```powershell
$env:DEYE_HOST="192.168.1.50"
$env:DEYE_PORT="8899"
$env:DEYE_UNIT_ID="1"
npm run dev
```
