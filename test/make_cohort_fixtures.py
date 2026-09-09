"""Build the synthetic cohort files used by the group tests.

Six animals, three in each of two groups, with a deliberate difference in flow
response so the comparison has something to find. No real animal data.
Run from the repo root:  python3 test/make_cohort_fixtures.py
"""
import numpy as np
import scipy.io as sio

OUT = 'test/matfiles'
N_RAW, N_SFDI = 1200, 360
T_END = 3.6

# group, animal id, response amplitude, per-animal offset
ANIMALS = [
    ('WT',  301, 0.26,  0.010),
    ('WT',  302, 0.23, -0.008),
    ('WT',  303, 0.28,  0.004),
    ('FAD', 311, 0.07, -0.006),
    ('FAD', 312, 0.05,  0.011),
    ('FAD', 313, 0.09, -0.003),
]


def build(seed, amp, offset):
    rng = np.random.default_rng(seed)
    t = np.linspace(0, T_END, N_RAW)
    step = 1 / (1 + np.exp(-(t - 1.0) / 0.15))
    sfi = 4000 * (1 + offset) * (1 + amp * step) + rng.normal(0, 25, N_RAW)

    mt = np.arange(N_SFDI) / 100.0
    step2 = 1 / (1 + np.exp(-(mt - 1.0) / 0.15))
    hbo2 = 0.060 * (1 + 0.5 * amp * step2) + rng.normal(0, 2e-4, N_SFDI)
    hbr = 0.030 * (1 - 0.3 * amp * step2) + rng.normal(0, 1e-4, N_SFDI)
    return {
        'lsi': {'time': t.reshape(1, -1), 'mean_data': sfi.reshape(1, -1)},
        'sfdi': {
            'MetabolismTime': mt.reshape(1, -1),
            'hbo2': hbo2.reshape(1, -1),
            'hbr': hbr.reshape(1, -1),
            'hbtot': (hbo2 + hbr).reshape(1, -1),
            'scatter730': (0.80 + 0.01 * np.sin(mt)).reshape(1, -1),
        },
    }


for i, (grp, num, amp, off) in enumerate(ANIMALS):
    d = build(1000 + i, amp, off)
    sio.savemat(f'{OUT}/Mouse {num}_{grp}_Baseline.mat', d['lsi'], do_compression=True)
    sio.savemat(f'{OUT}/Mouse {num}_{grp}_roi.mat', d['sfdi'], do_compression=True)
    print(f'Mouse {num} ({grp})')
