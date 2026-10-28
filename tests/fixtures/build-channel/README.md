# Public build identity fixtures

These small synthetic universal updater archives were generated once outside
the test runner. Their embedded `o8-build-channel.json` records Stable or Beta
for version `0.1.900`. `public-key.txt` and archive signatures are public fixture
data; no private key is retained. Tests authenticate the existing archives and
replace only platform/provider process edges. They never sign or publish.
