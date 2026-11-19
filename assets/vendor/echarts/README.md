# Apache ECharts 6.1.0 (offline browser runtime)

- Upstream release: https://github.com/apache/echarts/releases/tag/6.1.0
- Release package: https://registry.npmjs.org/echarts/-/echarts-6.1.0.tgz
- Package integrity (SHA-512, base64): `q0yaFPggC9FUdsWH4blavRWFmxdrIodbkoKNAjJudAI6CA9gNPxHtV2RcZNEepZVlk4yvBYkOkbk6HIVpIyHZA==`
- `echarts.min.js` is the unmodified `package/dist/echarts.min.js` (1,121,883 bytes).
- `LICENSE`, `NOTICE`, and `licenses/LICENSE-d3` are copied verbatim from the package.

| File | SHA-256 |
| --- | --- |
| `echarts.min.js` | `b66b25aeb4df84e33199dc21694014d336d222cbd9deb0e5a7c14bd6aa0d0fd0` |
| `LICENSE` | `634293835b43a6dd2094fa39182a3d9a6b9ca43b7fdb9ac354e8037af2a3093a` |
| `NOTICE` | `d491d358344f842685c1b1585970999db65fe30ecf7ef3867af8814f4016c016` |
| `licenses/LICENSE-d3` | `e1211892da0b0e0585b7aebe8f98c1274fba15bafe47fa1f4ee8a7a502c06304` |

The `notes` feature owns this directory. The chart adapter loads the script on
the first render of a populated chart. Building and running Relatum use these
local files directly.
