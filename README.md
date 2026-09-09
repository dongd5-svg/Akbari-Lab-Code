# DSP, Akbari Lab

Drop `.mat` files onto a web page and get blood flow, oxygen metabolism, plots
and CSVs back.

Double-clicking `index.html` is enough to run it: no server, no install. Putting
the folder on GitHub Pages gives it a URL you can open from any computer, which
is how the lab uses it.

Files are read inside the browser and nothing is uploaded.

## Putting it on GitHub Pages

1. Copy everything in this folder into a repository and push.
2. Settings, then Pages, then Deploy from a branch: `main`, folder `/ (root)`.
3. It appears at `https://<user>.github.io/<repo>/`.

There is no build step. It is plain HTML, CSS and JavaScript, with the two
libraries it needs already in `vendor/`.

The sample `.mat` files in `test/matfiles/` and the reference values in
`fixtures/` are synthetic. No animal data is included, so this folder is safe to
push to a public repository. If you later drop real recordings in there for
testing, either keep the repository private or take them out first.

## What to give it

| File | Must contain | You get |
|---|---|---|
| LSI, required | `time`, `mean_data` | rCBF, cleaned and resampled traces |
| SFDI ROI, optional | `MetabolismTime`, `hbo2`, `hbr`, `hbtot`, `scatter730` | aCMRO2, rCMRO2, rCBF/rCMRO2 |

Drop several animals at once. Files are grouped by the animal name in the
filename, so `Mouse 272_Baseline.mat` and `Mouse 272_roi.mat` end up together.
An animal with no SFDI file still works; you get flow results and a note saying
CMRO2 was skipped.

Reads MATLAB v6, v7 and v7.3, including variables nested inside structs.

## Settings

| Setting | Meaning |
|---|---|
| Baseline anchor | Relative values use the half minute before this time. 1 for a baseline recording, otherwise the time the intervention started. |
| Artifact cutoffs | Flow outside this range is replaced with the last good sample. |
| Camera exposure | Must match acquisition. It scales the flow values. |

## Getting the numbers out

Summary CSV is one row per animal: point count, spikes removed, and the mean of
each metric.

Data CSV is every timepoint, the same values you would read out of the struct in
MATLAB. Columns are `Animal`, `Time_min`, `CBF_SFI`, `rCBF`, and where SFDI was
supplied `aCBF_Db_mm2_per_s`, `aCMRO2_umol_per_min`, `rCMRO2`,
`rCBF_over_rCMRO2`, `HbO2_uM`, `HbR_uM`, `HbTot_uM` and `musp730_per_mm`.
Several animals go in one file, tagged by the `Animal` column. Animals without
SFDI leave the oxygen columns empty.

`AkbariAnalysis.m` writes the same thing: `summary.csv`, plus a `traces` folder
with one `<animal>_data.csv` per animal. `S.saveTraces = false` turns it off.

## Groups

Type a label into the Group box beside each animal in the file table. The
labels are guessed from the filenames first, so files like
`Mouse 301_WT_Baseline.mat` usually arrive already sorted, and a guess is
dropped if it does not split the animals into more than one group.

Once two groups exist you get a Groups tab on the plots, drawn as group mean
with an SEM band; a table of n, mean, SD and SEM per group; and a comparison of
any two groups with a Welch t-test and a Mann-Whitney test. Both run on the
per-animal means, so n is the number of animals rather than the number of
timepoints, and the Mann-Whitney p value is exact at cohort sizes. Nothing is
corrected for testing five metrics at once.

Ticking "Group mean ± SEM" in the Figure section draws the same thing as an SVG
for a manuscript. Three CSVs come out of the Groups panel: the stats table, the
averaged traces in long format, and the comparison with its p values.

The MATLAB script takes a `groups` cell array in the settings block, one label
per animal, and writes `group_summary.csv` alongside the rest. It does not run
the tests, to avoid depending on the Statistics Toolbox.

## Figures for papers

The interactive plots are for looking at data on screen. For a manuscript the
Figure section produces SVG laid out in real millimetres.

- Width presets are 85 mm single column, 114 mm 1.5 column, 170 mm double
  column. A figure exported at 85 mm arrives in the journal template at 85 mm.
- Text stays as text, so it is selectable, searchable and editable in
  Illustrator, Inkscape or Word. Nothing is converted to outlines or bitmaps.
- Subscripts and superscripts are real SVG tspans, so CMRO2 and mm^-1 survive a
  font change during typesetting.
- Axes are hairline with outward ticks and no box or gridlines, which is what
  most journals ask for. Gridlines are available if you want them.
- Small or large values get a common exponent in the axis label, so ticks read
  1.5, 2.0, 2.5 with (x10^-5) beside the label, rather than 0.000015 on every
  tick.
- Panels stack with shared x axis and automatic A, B, C labels.
- Greyscale mode switches to black and dashed grey, for journals that charge
  for colour.

Pick SVG unless a journal insists otherwise. If it does, PNG exports at 300,
600 or 1200 dpi at the true physical size.

Line data is reduced to at most two points per output column, keeping the
minimum and maximum in each. The curve looks identical but a 12,000 sample
recording exports as roughly 20 kB rather than a couple of megabytes that
Illustrator struggles to open.

## Checking the numbers

Open `test.html`. It runs this browser's maths against reference values from the
MATLAB pipeline and prints a pass or fail for each.

| Quantity | Agreement with MATLAB |
|---|---|
| Db | exact, every value identical |
| Spline resampling | 1e-15 |
| Absolute CMRO2 | 1e-17 |
| Relative CBF and CMRO2 | 5e-13 |

Db has to match exactly because it is chosen from a fixed grid of candidates. A
single differing value would mean the fit landed on a different grid point. The
continuous quantities differ only in the last few bits, which cannot be avoided
when arithmetic runs on a different platform.

The `.mat` reading checks are skipped when you open the page from disk, because
browsers block a local page from fetching other local files. Everything else
runs. To include them, serve the folder over http:

```
python -m http.server 8000
```

then open `http://localhost:8000/test.html`.

## Layout

```
index.html        the viewer
test.html         numerical checks
js/
  spline.js       not-a-knot cubic spline, matching MATLAB's spline()
  pipeline.js     the CMRO2 maths
  matfile.js      .mat reader, v6/v7 and v7.3
  analysis.js     works out what each file is and pairs them up
  charts.js       plots
  app.js          page wiring
fixtures/         MATLAB reference values used by test.html
test/matfiles/    sample .mat files in each format
test/*.mjs        the same checks under Node
vendor/           h5wasm (HDF5) and uPlot (plots)
```

Scripts are loaded as ordinary `<script>` tags rather than ES modules. Modules
would be blocked when the page is opened from disk, which is why the file works
by double-clicking.

Running the checks outside a browser:

```
npm install
npm test
```

## Speed

Measured on the same 11,984 sample recording, one animal through the CMRO2
stage:

| | Time |
|---|---|
| MATLAB `cmro2Analyze` | 47.7 ms |
| This page, in Chromium | 13.4 ms |

Roughly three times quicker, though at these sizes neither is worth thinking
about. MATLAB stays the reference implementation and is the only one that can
do the raw image stages.

## Limits

- This is a third implementation of the maths, after the original scripts and
  the refactored MATLAB. It is checked, but only against the current fixtures,
  so re-run `test.html` after changing either side.
- Raw image processing is not here. Turning `.tif` frames into `time` and
  `mean_data`, and SFDI frames into haemoglobin maps, still happens in MATLAB,
  because those stages need the Monte Carlo model and phantom calibration files.
- `K = 1/(0.01*SFI)` is carried over from the original code unchanged. It is not
  dimensionally consistent with `SFI = 1/(2*T*K^2)`. Relative results are
  unaffected. Check it before publishing absolute Db or CMRO2 values.
