# Property Details

Give it a list of Denver-metro, Colorado property addresses. It returns the **owner name** and **zoning** for each, with the source URL of every value. Uses only free public data and needs no API keys.

Counties covered: Denver, Adams, Arapahoe, Jefferson, Douglas, Broomfield, Boulder.

## Run

Requires Node 18 or newer. No dependencies.

```
node property-lookup.js --address "144 W Colfax Ave, Denver, CO"
node property-lookup.js --in examples/addresses.csv
node property-lookup.js --selftest
```

`--in` reads a CSV with an address column (the first column whose header contains "address") and writes `<name>-property-intel.csv` plus a `.json` copy. Options: `--out <file>`, `--column <name>`.

## Output columns

owner, owner2, owner_mailing, parcel_id, county, jurisdiction, land_use, zoning_code, zoning_desc, matched_address, lat, lon, parcel_data_date, owner_source, zoning_source, notes.

A value that can't be found is `NOT_FOUND`, with the reason in `notes`. Nothing is guessed.

## How it works

1. **Owner:** Colorado's statewide parcel layer (annual county submissions, so a recent sale may not show).
2. **Location:** that layer's street address, then the state address points, then the US Census geocoder.
3. **City or unincorporated:** DRCOG city boundaries.
4. **Zoning:** the city's or county's own zoning layer, listed in `sources/*.json`. Denver and Broomfield fall back to the code in the parcel data.

## Known limits

- Glendale, Cherry Hills Village, Columbine Valley, Bow Mar, Foxfield, Lakeside, Mountain View, Morrison and Nederland publish no online zoning layer. Those rows return `NOT_FOUND` with a note.
- Lafayette (2021), Longmont (October 2024) and Federal Heights (unofficial copy) may be out of date. Affected rows are flagged.
- The same street address in two cities without a city or ZIP is flagged `AMBIGUOUS`.
- Addresses outside the seven counties are not searched.

Add a jurisdiction by appending an entry to a file in `sources/` (`url`, `codeField`, `descField`, `kind`, `county`, `jurisdiction`).
