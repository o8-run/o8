# Public build identity fixtures

These small synthetic universal updater archives were generated once outside
the test runner. Their embedded `o8-build-channel.json` records Stable or Beta
for version `0.1.900`. `public-key.txt` and archive signatures are public fixture
data; no private key is retained. Publication tests add synthetic runtime inputs
and authenticate those fixture bytes with a disposable test-only Ed25519 key.
Platform/provider process edges are replaced; no product signing or publication runs.
