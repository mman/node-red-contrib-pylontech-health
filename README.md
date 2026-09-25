# node-red-contrib-pylontech-health

Node-RED node that reads **per-cell health data** from a Pylontech battery stack (US2000 / US3000 /
UP2500 / US5000 / Force …) over the master battery's **console port** and emits ready-to-write
**InfluxDB points**. Built to run inside Node-RED on a **Victron Cerbo GX** (Venus OS Large ≥ 3.80),
but works on any Node-RED ≥ 3 with Node.js ≥ 22.

The data it collects is meant for charts like these, here from Grafana over InfluxDB. The first
one is a state timeline of every cell's voltage over time, showing how the cells of a battery
charge and discharge and how far apart they sit; the second shows the BMS's passive balancing
in action, cell by cell, over the same period. This particular battery was rebuilt from packs at
different states of charge and is being top-balanced; a fully balanced pack, and a stack with
several batteries, will replace these pictures later.

![Cell voltage over time](https://raw.githubusercontent.com/mman/node-red-contrib-pylontech-health/main/docs/pylontech_cell_voltage.png)

![Passive cell balancing over time](https://raw.githubusercontent.com/mman/node-red-contrib-pylontech-health/main/docs/pylontech_cell_balancing.png)

Per poll the node runs `pwr` → `info N` + `stat N` (cached, hourly) → `bat N` (→ `soh N`, optional) for
every battery in the stack and produces three measurements:

| measurement         | tags                                                           | key fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pylontech/cell`    | `chain`, `battery`, `cell`, `barcode`, `battery_id`, `cell_id` | `voltage` V, `current` A, `temperature` °C, `soc` %, `coulomb` Ah, `balancing`, `soh` %, `base_state`, `volt_state`, `curr_state`, `temp_state`                                                                                                                                                                                                                                                                                                                                                              |
| `pylontech/battery` | `chain`, `battery`, `barcode`, `battery_id`                    | `voltage`, `current`, `temperature`, `temp_low`, `temp_high`, `volt_low`, `volt_high`, `soc`, `coulomb`, `mos_temperature`, `cell_min_voltage`, `cell_max_voltage`, `cell_spread`, `cell_min_index`, `cell_max_index`, `cell_count`, `firmware`, `*_state`; from `stat N`: `soh`, `cycle_count`, `power_on_hours`, `shutdown_count`, `reset_count`, `max_charge_volt_diff`, `max_discharge_volt_diff`, `bat_hv_count`, `bat_lv_count`, `bat_ov_count`, `bat_uv_count`, `life_warn_count`, `life_alarm_count` |
| `pylontech/stack`   | `chain`                                                        | `battery_count`, `cell_count`, `voltage` (avg), `current` (sum), `soc` (min), `cell_min_voltage`, `cell_max_voltage`, `cell_spread`, `temp_min`, `temp_max`, `poll_duration_ms`, `error_count`                                                                                                                                                                                                                                                                                                               |

`battery_id` (`B01`) and `cell_id` (`C07`) are zero-padded copies of the position tags so that
series sort correctly as strings. Combine them in Grafana aliases: `$tag_battery_id/$tag_cell_id`
gives `B01/C07`, `$tag_barcode/$tag_cell_id` gives `P222061C32221950/C07`.
All numeric fields are SI (volts, amps, °C, Ah). `chain` / `battery` follow the Venus OS
"Chain X · Battery Y" naming, `battery` being the 1-based position in the stack (the same `N` you'd
pass to `bat N`). `barcode` is the battery's serial from `info N`, so a module keeps its history if
it is moved to another slot. `cell_spread` (max − min cell voltage of a module) is the number to
alarm on.

---

## Preparing the Cerbo GX

### 1. Prerequisites

- Venus OS **Large** image, version 3.80 or newer, with Node-RED enabled:
  _Settings → Venus OS Large features → Node-RED → Enabled_.
- Root SSH access: _Settings → General → Set root password_, then enable SSH on LAN in the same menu.
  Log in with `ssh root@<cerbo-ip>`.
- Venus OS 3.80 ships Node.js 24 with Node-RED; nothing else needs to be installed.

### 2. Connect the diagnostic cable

Connect the master battery's **Console** RJ45 port (not the RS485 or CAN ports) through a Pylontech
console cable / RS232 adapter to a USB–serial adapter on the Cerbo. The Pylontech RJ45 console pinout
is pin 3 TX, pin 6 RX, pin 8 GND (RS232 levels).

Check that the adapter enumerates:

```sh
ls -l /dev/serial/by-id/
dmesg | tail
```

You should see something like `usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0 -> ../../ttyUSB0`.
Note the `ttyUSBn` name, it is needed once in the next step.

### 3. Register the cable as `/dev/ttyPYLON`

This step does two things at once, and everything later relies on it:

- **Keeps Venus off the port.** Venus OS runs `serial-starter`, which probes every new `ttyUSB*`
  device with its VE.Direct, MK3, GPS and other drivers. It would hold the port open and send
  garbage to the battery. Devices whose udev environment has `VE_SERVICE=ignore` are skipped.
- **Gives the cable a fixed name.** The rule creates `/dev/ttyPYLON`, which is the default serial
  port of the node, the CLI and the example flow. `ttyUSB0` can become `ttyUSB1` after a reboot or
  when another USB device is plugged in; `/dev/ttyPYLON` always points at the Pylontech cable.

**a) Identify the adapter.** Match the rule to the adapter itself, not to its current `ttyUSBn`:

```sh
udevadm info -q property -n /dev/ttyUSB0 | grep -E 'ID_VENDOR_ID|ID_MODEL_ID|ID_MODEL=|ID_SERIAL_SHORT'
```

Note the `ID_SERIAL_SHORT` value (e.g. `A50285BI`). If your adapter has no serial number, use
`ID_VENDOR_ID` + `ID_MODEL_ID` instead (see the variant below).

**b) Install the rule so that it survives reboots and firmware updates.** The Venus root
filesystem is mounted **read-only** and `/etc` is replaced on every firmware update, while `/data`
is kept. Venus runs `/data/rcS.local` early in boot, so the script below remounts the root
filesystem writable, appends the rule to Venus's own `serial-starter.rules` if it is missing, and
re-triggers udev so an already plugged cable is re-tagged.

Replace `A50285BI` with your adapter's `ID_SERIAL_SHORT`, then paste the whole block into the
SSH session:

```sh
mkdir -p /data/udev
cat > /data/udev/serial-starter.rules <<'RULE'
# Pylontech console cable - keep serial-starter away from it, expose it as /dev/ttyPYLON
ACTION=="add", ENV{ID_BUS}=="usb", ENV{ID_SERIAL_SHORT}=="A50285BI", ENV{VE_SERVICE}="ignore", SYMLINK+="ttyPYLON"
RULE

cat > /data/rcS.local <<'SCRIPT'
#!/bin/sh
RULES=/etc/udev/rules.d/serial-starter.rules
if ! grep -q ttyPYLON "$RULES"; then
  /opt/victronenergy/swupdate-scripts/remount-rw.sh
  cat /data/udev/serial-starter.rules >> "$RULES"
  udevadm control --reload-rules
  udevadm trigger --subsystem-match=tty --action=add
fi
SCRIPT
chmod +x /data/rcS.local

sh /data/rcS.local
```

Without the `remount-rw.sh` line the append fails silently with "Read-only file system" and
serial-starter grabs the port again after the next reboot.

If `/data/rcS.local` already exists (e.g. from dbus-serialbattery or another add-on), append the
`if … fi` block to it instead of overwriting the file.

Variant for an adapter without a usable serial number, matching the vendor/model IDs instead:

```sh
ACTION=="add", ENV{ID_BUS}=="usb", ENV{ID_VENDOR_ID}=="0403", ENV{ID_MODEL_ID}=="6001", ENV{VE_SERVICE}="ignore", SYMLINK+="ttyPYLON"
```

Appending to `serial-starter.rules` itself means our line is evaluated last within the file that
serial-starter reads, so `VE_SERVICE=ignore` is the final value. This is the setup verified on a
Cerbo GX running Venus OS 3.80.

### 4. Verify

Re-plug the cable (or reboot) and check that `/dev/ttyPYLON` exists and nothing grabbed the port:

```sh
ls -l /dev/ttyPYLON                                          # -> ttyUSBn
udevadm info -q property -n /dev/ttyPYLON | grep VE_SERVICE  # -> VE_SERVICE=ignore
for s in /service/*ttyUSB*; do svstat $s; done               # all "down" (or no such services)
```

Service directories created before the rule took effect stay listed under `/service` but must all
report `down`; they disappear after a reboot.

### 5. Install the node

Either in the Node-RED editor: _Menu → Manage palette → Install → search
`node-red-contrib-pylontech-health`_, or from the shell:

```sh
cd /data/home/nodered/.node-red        # Node-RED runs as user "nodered" on Venus OS Large 3.x
npm install node-red-contrib-pylontech-health
chown -R nodered:nodered /data/home/nodered/.node-red
svc -t /service/node-red-venus        # restart Node-RED
```

If unsure about the directory, `ps | grep node-red` shows the path Node-RED was started with.

The package's only dependency is `serialport`, whose native binding ships prebuilt for the
Cerbo's ARMv7 glibc inside the npm tarball. No compiler or extra download is needed; the install
only requires internet access to the npm registry and a little free space on `/data`.

Deploy the node with the default port `/dev/ttyPYLON`: a green **ready** status means the battery
answered with its `pylon>` prompt.

### 6. After a reboot or a Venus OS firmware update

`/data` is preserved, so `/data/rcS.local` re-applies the rule automatically at boot, including
after a firmware update that replaced `/etc`. If the battery stops answering after a reboot, run
the checks from step 4; `sh -x /data/rcS.local` shows whether the append succeeded.

---

## Checking the installation from the command line

The package ships a CLI that runs exactly the same console, poll and point-building code as the
node, without Node-RED. After installing into `/data/home/nodered/.node-red`, run it on the Cerbo
with (stop the Node-RED flow first, or the two will fight over the port):

```sh
cd /data/home/nodered/.node-red
node node_modules/node-red-contrib-pylontech-health/dist/cli.js --help
alias pyl='node node_modules/node-red-contrib-pylontech-health/dist/cli.js'
```

Options default to the node's defaults (`--port /dev/ttyPYLON` from step 3, `--baud 115200`, wake
sequence on).
Progress goes to stderr, results to stdout, so output can be piped or redirected.

```sh
# 1. does the console answer? prints battery positions from pwr and the master's info
pyl probe

# 2. one raw command, to eyeball your firmware's table layout
pyl raw pwr
pyl raw bat 1

# 3. the full poll as the structured model (output 2 of the node)
pyl poll | head -60

# 4. the influx points (output 1 of the node), one measurement at a time
pyl points --only stack
pyl points --only battery
pyl points --only cell | head -40

# 5. line protocol, e.g. straight into InfluxDB 1.x (timestamps are milliseconds)
pyl points --format line > points.lp
curl -i -XPOST 'http://127.0.0.1:8086/write?db=venus&precision=ms' --data-binary @points.lp

# 6. save your firmware's outputs (pwr, info N, stat N, bat N) as fixtures to attach to a bug report
pyl capture /data/pylontech-fixtures
```

Exit code is 0 on success, 1 if the port could not be opened or some batteries reported errors,
2 for usage errors. `--no-wakeup`, `--chain`, `--prefix`, `--cell-base 0`, `--no-states`, `--soh`,
`--no-stat` and `--timeout` mirror the node's configuration.

## Using the node

Import `examples/pylontech-influx.json` (_Menu → Import → Examples → node-red-contrib-pylontech-health_).
It wires an inject node every 60 s → **pylontech health** → **influxdb batch** (from
[node-red-contrib-influxdb](https://flows.nodered.org/node/node-red-contrib-influxdb)), and a debug
node on the second output.

### Configuration

| option             | default         | meaning                                                                                                                                     |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Serial port        | `/dev/ttyPYLON` | Device path of the console cable (the symlink from the setup steps above)                                                                   |
| Baud               | `115200`        | Console speed after wake-up                                                                                                                 |
| Wake sequence      | on              | Open at 1200 baud, send the Pylontech switch sequence, then change to _Baud_                                                                |
| Chain              | `1`             | Value of the `chain` tag (one console cable = one chain/stack)                                                                              |
| Measurement prefix | `pylontech`     | Measurements become `<prefix>/cell`, `<prefix>/battery`, `<prefix>/stack`                                                                   |
| Cell numbering     | 1-based         | `cell` tag: 1…15 like Venus OS, or 0…14 like the raw `bat` output                                                                           |
| Include states     | on              | Add `base_state`, `volt_state`, … string fields                                                                                             |
| Read stat          | on              | Read `stat N` with each info refresh: state of health, cycle count, lifetime counters                                                       |
| Read SOH           | off             | Also run `soh N` and add the `soh` field. Not every firmware has the command (US3000C B69.25 does not); the node warns once and disables it |
| Refresh info       | `60` min        | Re-read `info N` (barcode, firmware) at most this often; `0` = every poll                                                                   |
| Command timeout    | `3000` ms       | Console silence before a command is failed (long paged outputs are fine)                                                                    |
| Poll timeout       | `30000` ms      | For the whole cycle; on expiry the node reconnects                                                                                          |

### Input

- Any message → one poll.
- `msg.refresh = true` → also re-read `info N` for every battery.
- `msg.command = "bat 2"` → run a single raw console command and return `{ command, raw }` on
  output 2 only. Handy for checking your firmware's output format.

### Outputs

1. `msg.payload` — array of `{ measurement, tags, fields, timestamp }` points, the format expected by
   the **influxdb batch** node (InfluxDB 1.x and 2.x).
2. `msg.payload` — the structured reading:

```js
{
  chain: 1, polledAt: Date, durationMs: 3210,
  batteries: [{
    position: 1,
    info:  { barcode, deviceName, cellNumber, firmware: { main, soft, boot, comm, board }, raw: {...} },
    power: { voltage, current, temperature, tempLow, tempHigh, voltLow, voltHigh, soc, mosTemperature, states: {...} },
    cells: [{ index, voltage, current, temperature, soc, coulombAh, balancing, soh?, states: {...} }],
    cellStats: { min, max, spread, minCell, maxCell, count }
  }],
  errors: []
}
```

If a poll fails, output 2 carries `payload: null` and `msg.error` with the reason.

### Status

- yellow ring — connecting
- green dot `ready` — console answered with `pylon>`
- blue dot `polling 1/2 · bat 1` — poll in progress
- green dot `2 batt · 30 cells · 3.2s` — last poll OK (yellow if some batteries had errors)
- red ring — cannot open the port or the port disappeared; retries with back-off (5 s → 60 s)

### Query examples

The `/` in measurement names is fine for InfluxDB but must be double-quoted in InfluxQL:

```sql
-- newest cell voltages of battery 1
SELECT voltage FROM "pylontech/cell" WHERE battery = '1' ORDER BY time DESC LIMIT 15

-- one series per cell, correctly ordered; in Grafana set ALIAS BY to $tag_battery_id/$tag_cell_id
SELECT mean("voltage") FROM "pylontech/cell" WHERE $timeFilter GROUP BY time($__interval), "battery_id", "cell_id"

-- worst cell spread per module over the last day
SELECT max("cell_spread") FROM "pylontech/battery" WHERE time > now() - 1d GROUP BY "barcode"
```

Flux:

```
from(bucket: "venus")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "pylontech/cell" and r._field == "voltage")
```

## Supported firmware / output formats

Parsing is header-driven: columns are matched by name, so firmware variants with or without
`MosTempr`, `BAL` or extra columns work. Tested formats live in `test/fixtures`, including real
captures from a US3000C on firmware B69.25.0.0 (which has `stat` but no `soh`). Long outputs that
the console pages with _Press [Enter] to be continued_ are handled automatically. If your battery
prints something the node does not understand, capture it with `msg.command = "pwr"`,
`"info 1"`, `"bat 1"` and open an issue with the output.

## Development

```sh
npm install
npm test          # vitest: parsers, points, console (fake port), node (node-red-node-test-helper)
npm run lint
npm run build     # tsc → dist/ + copies the editor HTML
npm pack          # tarball as installed by the palette manager
```

Install a local build on a Cerbo for testing:

```sh
npm pack
scp node-red-contrib-pylontech-health-*.tgz root@<cerbo-ip>:/data/
ssh root@<cerbo-ip> 'cd /data/home/nodered/.node-red && npm install /data/node-red-contrib-pylontech-health-*.tgz && chown -R nodered:nodered . && svc -t /service/node-red-venus'
```

## License

MIT
