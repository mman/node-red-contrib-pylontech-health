# Reading Pylontech data over CAN

This note records what a Pylontech stack publishes on the BMS-Can bus, what it will only
publish if asked, and why the console cable is still required for per-cell health data.

It exists because of a suggestion by Dean Perry in the
[project announcement thread](https://community.victronenergy.com/t/introducing-pylontech-battery-health-node-red-integration/64031/9):
that the extended data could be read "over CAN, using socketcan, without requiring a
diagnostic cable", given firmware newer than roughly 2022 and no LV-Hub in the way.
Alex Pescaru pointed at the published protocol document. Both were right that the data
exists — the detail that decides how useful it is turns out to be its granularity.

## Summary

| | Console cable (`pylontech-health` node) | CAN, broadcast | CAN, on request |
| --- | --- | --- | --- |
| Individual cell voltages | yes, all 15 per module | no | no |
| Individual cell temperatures | yes | no | no |
| Per-cell balancing flag | yes | no | no |
| Min/max cell voltage | per module | stack only | per module |
| Min/max cell temperature | per module | stack only | per module |
| SOH, cycle count, lifetime counters | per module | stack SOH only | per-module SOH only |
| MOSFET / BMS temperature | MOSFET only | no | yes |
| Serial number, firmware version | per module | master only | per module |
| Needs a diagnostic cable | yes | no | no |
| Needs us to transmit on the bus | no | no | **yes** |

**CAN cannot replace the console cable for this project.** The weak-cell dashboards are
built on individual cell voltages, and CAN never carries them — at best it reports the
minimum and maximum within each module. CAN is a useful *additional*, lower-resolution
source, not a substitute.

## Running the probe

`pylontech-health can-probe` decodes what is on the bus. It is read-only by default:

```
# pylontech-health can-probe --interface can1 --duration 8
listening on can1 for 8 s (read-only) …
stack   PYLON US3000D  firmware 1.4
        6 module(s) online, 0 offline, 0 blocking charge, 0 blocking discharge
        49.11 V  11.7 A  24.7 C  SOC 20 %  SOH 100 %
        cell 3.250 - 3.286 V (spread 36 mV)
        cell 23.0 - 26.0 C
        min V module 1/3, max V module 1/3, min T module 1/6, max T module 1/1
        installed capacity 444 Ah
        charge limit 53.2 V / 222.0 A, discharge limit 45.0 V / 222.0 A
        charge enabled, discharge enabled
        no protections, warnings or alarms
```

`--format json` prints the structured reading instead. `--request` additionally transmits;
see [Asking for the per-module data](#asking-for-the-per-module-data) before using it.

### Finding the interface

On a Cerbo GX, BMS-Can is `can1` and VE.Can is `can0`; on other GX models and with USB-CAN
adapters the numbering differs. Profile 3 at 500 kbit/s is the CAN-bus BMS (LV) setting:

```
ip -br link show type can
dbus -y com.victronenergy.settings /Settings/Canbus/can1/Profile GetValue   # 3 = BMS LV
ip -d link show can1 | grep bitrate                                        # 500000
```

### Coexisting with Victron's driver

Running alongside `can-bus-bms` is not a conflict. SocketCAN interfaces are netdevices, not
exclusive character devices like `/dev/ttyUSB0`: every socket bound to the interface receives
its own copy of every frame, which is why Victron's own support advice is to `candump` the BMS
port while the driver is running.

No privileges are needed either. `CAN_RAW` socket creation is not gated behind `CAP_NET_RAW`
on current kernels, so the unprivileged `nodered` user can read the bus. Verified on a Cerbo
GX running Venus OS v3.80 with `can-bus-bms` v0.72 live on `can1`:

```
# su -s /bin/sh nodered -c "candump -n 3 can1"
  can1  351   [8]  14 02 AC 08 AC 08 C2 01
  can1  355   [4]  13 00 64 00
  can1  356   [6]  24 13 68 00 F9 00
```

The probe shells out to `candump` and `cansend` rather than binding `AF_CAN` itself. The npm
`socketcan` package needs a node-gyp build and ships no prebuilt binaries, so it cannot be
installed on a GX device; `can-utils` is already in the Venus OS image at `/usr/bin`.

## What the battery broadcasts

These standard (11-bit) frames arrive unasked, roughly once a second. Payloads are
little-endian. Captured from a 6× US3000D stack on firmware 1.4; the capture is committed as
`test/fixtures/candump-us3000d-can1.txt`.

| ID | Contents |
| --- | --- |
| `0x351` | charge voltage limit (0.1 V), charge current limit (0.1 A), discharge current limit (0.1 A), discharge voltage limit (0.1 V) |
| `0x355` | SOC (1 %), SOH (1 %) — both averaged over all modules |
| `0x356` | average module voltage (0.01 V), total current (0.1 A), average cell temperature (0.1 °C) |
| `0x359` | protection bits (bytes 0–1), warning bits (bytes 2–3), module count (byte 4), `"PN"` (bytes 5–6) |
| `0x35A` | alarm detail, two bits per alarm: `1,0` active, `0,1` inactive, `0,0` and `1,1` reserved |
| `0x35C` | bit 7 charge enable, bit 6 discharge enable, bit 4 force charge, bit 3 full charge |
| `0x35E` | brand, `"PYLON"`, bytes 0–4 |
| `0x373` | min cell voltage (0.001 V), max cell voltage (0.001 V), min and max cell temperature (whole Kelvin, `°C = K − 273`) |
| `0x374`–`0x377` | which module holds the min voltage / max voltage / min temperature / max temperature cell, as four ASCII digits: `"0103"` = group 1, module 3 |
| `0x379` | total installed capacity in Ah, 32-bit |

Two more are on the wire but absent from the published V2.0 tables, which list them as
"under develop". Their decode below is inferred from cross-checking against the values
`can-bus-bms` publishes on D-Bus at the same instant:

| ID | Inferred contents |
| --- | --- |
| `0x35F` | hardware version (bytes 0–1), firmware version (bytes 2–3, `01 04` = 1.4), online capacity in Ah (bytes 4–5) |
| `0x382` | battery model as ASCII, e.g. `"US3000D"` |

`0x37A`–`0x37F` and `0x385` are also broadcast and are **not decoded**. `can-probe` lists them
under `undecoded:` with their payloads so that new firmware shows up rather than being hidden.

The stack also carries two frames from the GX device rather than the battery: `0x305`
(heartbeat) and `0x307` (inverter identification, `"VIC"` in bytes 4–6).

## Asking for the per-module data

Section 2.5 of the protocol document, "extend module level", defines extended (29-bit)
request/response frames. **Nothing broadcasts these.** Revision 2.0.1 of 2021-04-02 changed
them "from sending by BMS to need trigger by upper device / inverter", and `can-bus-bms` never
asks — a 150-frame capture of a live `can1` contains no 29-bit frames at all.

Response ids are `base + N * 0x100 + M * 0x10000`, where `N` is the module address within a
group (the master battery is 1) and `M` is the group number (the first group is 1). So group 1,
module 3 answers the first request on `0x4010301`. Requests carry eight zero bytes and must be
at least 2 s apart.

Request `0x4000000`:

| Response | Bytes 0–1 | Bytes 2–3 | Bytes 4–5 | Bytes 6–7 |
| --- | --- | --- | --- | --- |
| `0x4000001` | min cell voltage, 0.001 V | max cell voltage, 0.001 V | current, 0.1 A signed | module voltage, 0.01 V |
| `0x4000002` | max cell temp, 0.1 °C signed | min cell temp, 0.1 °C signed | MOSFET temp, 0.1 °C signed | BMS temp, 0.1 °C signed |
| `0x4000003` | *reserved* | SOC, 1 % | SOH, 1 % | nominal capacity, Ah |
| `0x4000004` | status bitfield | flag bitfield | error code, 32-bit unsigned | |

Request `0x5000000`:

| Response | Contents |
| --- | --- |
| `0x5000001`–`0x5000004` | serial number, ASCII, bytes 1–8 / 9–16 / 17–24 / 24–32 (the last two reserved) |
| `0x5000005` | firmware version (bytes 0–1, `01 04` = 1.4), internal ID version (bytes 4–5) |

`0x4000004` status bits: 0 cell/module low voltage, 1 cell/module high voltage, 2 cell low
temperature, 3 cell high temperature, 4 charge high current, 5 discharge high current, 7 refer
to error code, 8 cell/module over voltage, 9 cell/module under voltage, 10 cell over
temperature, 11 cell under temperature, 12 charge over current, 13 discharge over current or
short circuit, 14 lock (charge and discharge forbidden). Flag bits: 0 force charge, 1 full
charge, 2 balance charge, 3 cell voltage difference, 13 discharge MOSFET status, 14 charge
MOSFET status, 15 this module is communication offline.

A field the spec defines but the firmware does not implement reads as all `0xFF`; an
undefined byte reads `0x00`.

### Why `--request` is opt-in

Transmitting is the part that is not yet proven safe here. Reading is passive; sending puts
frames on the bus your battery uses to talk to the GX device. Before relying on it:

- **Will the stack answer at all?** Dean Perry reports it needs firmware newer than about 2022
  (BMS protocol > 2.0) and the batteries must not sit behind an LV-Hub. Untested here.
- **How does `can-bus-bms` react?** It should ignore ids it does not parse, but it is closed
  source, and both the requests and the per-module replies are ids it has never seen.
- Watch for `BMS connection lost` and for `Connected` going to 0 on
  `com.victronenergy.battery.socketcan_can1` while experimenting.

`can-probe --request` prints a warning before it transmits, sends `0x4000000` then
`0x5000000` at the spec's minimum 2 s spacing, and extends a short `--duration` so it is still
listening when the answers arrive.

## What Venus OS already gives you for free

A useful subset needs no CAN code at all, because `can-bus-bms` already decodes the broadcast
frames onto D-Bus, where `node-red-contrib-victron` can read it:

| D-Bus path on `com.victronenergy.battery.socketcan_can1` | Frame |
| --- | --- |
| `Soh`, `Soc` | `0x355` |
| `System/MinCellVoltage`, `System/MaxCellVoltage` | `0x373` |
| `System/MinCellTemperature`, `System/MaxCellTemperature` | `0x373` |
| `System/MinVoltageCellId`, `System/MaxVoltageCellId` | `0x374`, `0x375` — the `"0103"` module address, *not* a cell index |
| `System/MinTemperatureCellId`, `System/MaxTemperatureCellId` | `0x376`, `0x377` |
| `System/NrOfModulesOnline`, `.../Offline`, `.../BlockingCharge`, `.../BlockingDischarge` | `0x372` |
| `Family`, `FirmwareVersion`, `Capacity`, `InstalledCapacity` | `0x382`, `0x35F`, `0x379` |
| `Diagnostics/Module{N}/Alarms/*`, `Diagnostics/Module{N}/Id` | per-module tree that exists but is unpopulated |

Note that despite the name, `MinVoltageCellId` is a module address, not a cell identifier.

## Sources

- *PYLON low voltage CAN Bus Protocol V2.0*, rev 2.0.1 of 2021-04-02 —
  <https://axelzone.ro/storage/victron/bms-pylontech.pdf>, posted to
  [Victron community topic 60598](https://community.victronenergy.com/t/venus-os-3-75-can-bus-bms-driver-intermittently-sets-false-warnings-etc/60598).
- Dean Perry's and Alex Pescaru's posts in
  [topic 64031](https://community.victronenergy.com/t/introducing-pylontech-battery-health-node-red-integration/64031/9).
- `test/fixtures/candump-us3000d-can1.txt` — the capture the decoders are tested against.
