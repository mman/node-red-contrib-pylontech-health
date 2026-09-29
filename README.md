# node-red-contrib-pylontech-health

Node-RED node that reads **per-cell health data** from a Pylontech battery stack (US2000 / US3000 /
UP2500 / US5000 / Force …) over the master battery's **console port** and emits ready-to-write
**InfluxDB points**. Built to run inside Node-RED on a **Victron Cerbo GX** (Venus OS Large ≥ 3.80),
but works on any Node-RED ≥ 3 with Node.js ≥ 22.

This package lets you assess the health of your Pylontech batteries by periodically collecting
every important metric the BMS exposes on its console (per-cell voltage, current, temperature,
SOC, balancing state, plus the per-battery and per-stack aggregates) and visualizing them over
time in Grafana. The charts below come from a six-battery stack over one day: discharging through
the evening, sitting at low SOC overnight, charging again in the morning.

**State of charge by battery.** Stacked `soc` from `pylontech/battery`, one band per module. All
six discharge and recharge together; a module that drifts away from the others here is the first
sign that its capacity or its coulomb counter is off.

![SOC by battery](https://raw.githubusercontent.com/mman/node-red-contrib-pylontech-health/main/docs/pylontech_stack_soc_by_battery.png)

**Cell voltage spread by battery.** `cell_voltage_spread` from `pylontech/battery`, the max minus
min cell voltage of each module, as a state timeline. Healthy modules stay under 20 mV. At low SOC
the weaker cells of B03 and B06 fall away from the rest and the spread climbs past 30 mV; it closes
again as soon as charging starts.

![Cell voltage spread by battery](https://raw.githubusercontent.com/mman/node-red-contrib-pylontech-health/main/docs/pylontech_stack_voltage_spread_by_battery.png)

**Temperature delta by battery.** `temperature_delta` from `pylontech/battery`, each module's
temperature minus the stack mean. The signed value shows which module runs warm or cold and by how
much: here B01 sits about a degree above the stack and B06 two to three degrees below it, which
is what you would expect from the modules at the top and bottom of a rack.

![Temperature delta by battery](https://raw.githubusercontent.com/mman/node-red-contrib-pylontech-health/main/docs/pylontech_stack_temperature_delta_by_battery.png)

**Every cell of the stack.** `voltage` from `pylontech/cell`, one lane per cell, aliased
`$tag_battery_id/$tag_cell_id` so the 90 lanes sort as B01/C01 … B06/C15. Full cells are orange,
the mid-charge plateau is green, and when the stack is nearly empty a group of lanes in B03 and
cell 11 of B06 turn blue: they rest just under 3.20 V while their neighbours hold 3.20–3.23 V.
This is the chart that tells you _which_ cells are behind the spread above, but it has a catch:
the colour steps are absolute, so a cell 8 mV under a boundary looks as bad as one 30 mV under it.

![Cell voltage of every cell in the stack](https://raw.githubusercontent.com/mman/node-red-contrib-pylontech-health/main/docs/pylontech_stack_voltage_spread_by_cell.png)

**Every cell relative to its own battery.** `voltage_delta` from `pylontech/cell`, cell minus the
mean of its module, in mV on a diverging scale: green within ±5 mV, blue below, yellow to red
above. Same lanes and the same day as the chart above, and it reads differently. Most of the
blue B03 lanes are only 5–10 mV under the mean and fade to pale blue at rest; the module's spread
is really cells 1–3 sitting 20–30 mV _above_ everything else. Cell 8 of B03 and cell 11 of B06
are the cells that are genuinely behind: blue at the bottom, and the last to fill at the top, where
the short blue stripes at 16:00 and 14:30 mark the lowest cell of each module during absorption.
Judge this chart at rest, after an hour or so of zero current; under load or during absorption a
±30 mV band is normal for LFP.

![Cell voltage delta to battery for every cell in the stack](https://raw.githubusercontent.com/mman/node-red-contrib-pylontech-health/main/docs/pylontech_stack_voltage_delta_by_cell.png)

Two extreme examples, from a single US3000C that was rebuilt from packs at different states of
charge and is being top-balanced. The first is the same per-cell voltage timeline for a badly
unbalanced module, with cells several hundred millivolts apart at the top of charge; the second is
the `balancing` field of `pylontech/cell` over the same period, showing the BMS's passive balancer
bleeding the high cells one by one.

![Cell voltage of an unbalanced battery](https://raw.githubusercontent.com/mman/node-red-contrib-pylontech-health/main/docs/pylontech_cell_voltage.png)

![Passive cell balancing over time](https://raw.githubusercontent.com/mman/node-red-contrib-pylontech-health/main/docs/pylontech_cell_balancing.png)

The panels behind these screenshots are in [`examples/`](examples/) as Grafana panel JSON:
`grafana-soc-by-battery.json`, `grafana-voltage-spread-by-battery.json`,
`grafana-temperature-delta-by-battery.json`, `grafana-cell-voltage.json`,
`grafana-cell-voltage-delta.json` (every cell minus its battery's mean, the chart that separates a cell
that is really behind from one that only looks so on an absolute scale), plus
`grafana-pwr-table.json`, a table that lays out the newest `pylontech/battery` point per module
like the console's `pwr` output. They can be used as they are with the latest
[Victron venus-grafana](https://github.com/victronenergy/venus-grafana), which ships
Grafana 13 and InfluxDB 1.x: point the **influxdb batch** node of the example flow at the InfluxDB
that venus-grafana configures (database `venus`), and the panels find their data through the
`datasource-influxdb` datasource that venus-grafana provisions. To add one, create an empty panel
on a dashboard, open _Inspect → Panel JSON_, replace the contents with the file and apply.

Per poll the node runs `pwr` → `info N` + `stat N` (cached, hourly) → `bat N` (→ `soh N`, optional) for
every battery in the stack and produces three measurements:

| measurement         | tags                                                           | key fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pylontech/cell`    | `chain`, `battery`, `cell`, `barcode`, `battery_id`, `cell_id` | `voltage` V, `current` A, `temperature` °C, `soc` %, `coulomb` Ah, `balancing`, `voltage_delta` V and `temperature_delta` °C (cell minus its battery's mean), `soh` %, `base_state`, `volt_state`, `curr_state`, `temp_state` (plus `dtemp_state`, `ctemp_state` on firmware that reports discharge and charge temperature states separately)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pylontech/battery` | `chain`, `battery`, `barcode`, `battery_id`                    | `voltage`, `current`, `temperature`, `temp_low`, `temp_high`, `volt_low`, `volt_high` (plus `temp_low_index`, `temp_high_index`, `volt_low_index`, `volt_high_index` on firmware whose `pwr` prints the `Tlow.Id` … `Vhigh.Id` columns, e.g. US3000D), `soc`, `coulomb`, `mos_temperature`, `temperature_delta` (battery minus stack mean), `cell_min_voltage`, `cell_max_voltage`, `cell_voltage_spread`, `cell_min_index`, `cell_max_index`, `cell_min_temperature`, `cell_max_temperature`, `cell_temperature_spread`, `cell_count`, `firmware`, `*_state`; from `stat N`: `soh`, `cycle_count`, `power_on_hours`, `shutdown_count`, `reset_count`, `max_charge_volt_diff`, `max_discharge_volt_diff`, `bat_hv_count`, `bat_lv_count`, `bat_ov_count`, `bat_uv_count`, `life_warn_count`, `life_alarm_count` |
| `pylontech/stack`   | `chain`                                                        | `battery_count`, `cell_count`, `voltage` (avg), `current` (sum), `soc` (min), `cell_min_voltage`, `cell_max_voltage`, `cell_voltage_spread`, `cell_temperature_spread`, `temp_min`, `temp_max`, `poll_duration_ms`, `error_count`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`battery_id` (`B01`) and `cell_id` (`C07`) are zero-padded copies of the position tags so that
series sort correctly as strings. Combine them in Grafana aliases: `$tag_battery_id/$tag_cell_id`
gives `B01/C07`, `$tag_barcode/$tag_cell_id` gives `P222061C32221950/C07`.
All numeric fields are SI (volts, amps, °C, Ah). `chain` / `battery` follow the Venus OS
"Chain X · Battery Y" naming, `battery` being the 1-based position in the stack (the same `N` you'd
pass to `bat N`). `barcode` is the battery's serial from `info N`, so a module keeps its history if
it is moved to another slot. `coulomb` is omitted when the firmware prints a zero counter next to a
non-zero SOC, which a US3000D master does for every cell of its slave batteries (only the master
reports a real Ah figure). `cell_voltage_spread` (max − min cell voltage of a module) is the
number to alarm on; `cell_temperature_spread` is its temperature twin. **Spread** fields are one
number per group, max minus min, always ≥ 0. **Delta** fields are one signed number per member,
member minus the group mean, so they show which cell or battery is off and in which direction.

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
node on the second output. The node's status line shows the result of the last poll.

![Example flow](https://raw.githubusercontent.com/mman/node-red-contrib-pylontech-health/main/docs/pylontech_health_node_red_flow.png)

### Configuration

![Node configuration dialog](https://raw.githubusercontent.com/mman/node-red-contrib-pylontech-health/main/docs/pylontech_health_node_red_config.png)

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
| Refresh info       | `60` min        | Re-read `info N` / `stat N` (barcode, firmware, lifetime statistics) at most this often; `0` = every poll                                   |
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
    cellStats: { min, max, mean, spread, minCell, maxCell, count, tempMin, tempMax, tempMean, tempSpread }
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

-- worst cell voltage spread per module over the last day
SELECT max("cell_voltage_spread") FROM "pylontech/battery" WHERE time > now() - 1d GROUP BY "barcode"

-- which cells run warm or cold relative to their module, one lane per cell in a state timeline
SELECT mean("temperature_delta") FROM "pylontech/cell" WHERE $timeFilter GROUP BY time($__interval), "battery_id", "cell_id"
```

Flux:

```
from(bucket: "venus")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "pylontech/cell" and r._field == "voltage")
```

## Supported firmware / output formats

Parsing is header-driven: columns are matched by name, so firmware variants with or without
`MosTempr`, `BAL`, extra columns, the split `DTemp. State` / `CTemp. State` pair, or the
`Tlow.Id` / `Thigh.Id` / `Vlow.Id` / `Vhigh.Id` columns of a US3000D master work. Tested formats live
in `test/fixtures`, including real captures from a US3000C on firmware B69.25.0.0 (which has `stat`
but no `soh`) and the `pwr` of a US3000D master (firmware 1.1) heading a mixed US3000D/US3000C stack.
On the US3000D neither `info` nor `stat` takes a battery index (`info`, `stat [detail]`): the node
notices the rejected `info N` / `stat N`, reads the bare command for the master instead, warns once
and stops asking the slaves. So the `barcode` tag, the `firmware` field, `soh`, `cycle_count` and
the other lifetime counters exist for battery 1 only, and its `stat` lacks power-on hours, the
volt-diff maxima and the life warning/alarm counters. That firmware also has no `soh` command and
does not relay the slaves' coulomb counters (see above). Long outputs that
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
