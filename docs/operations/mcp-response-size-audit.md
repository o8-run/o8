# MCP response size audit

Tracked by #4511. Base: `d73cca9a2d6ed88f4c6804f642265ce75833c57a`.
Both measurements used an isolated development server, a disposable profile,
and the same fixture state: a repository with a large o8.md and text diff,
plus 60 idle task lanes. The second profile was copied with a database backup.
No installed application data or native implementation was changed.

Sizes are UTF-8 bytes of the complete JSON-RPC HTTP response, including escaping.
The after column measures the first page. Each continuation page was also measured.

| Normal call | Before bytes | After bytes | Pages | Largest page bytes |
| --- | ---: | ---: | ---: | ---: |
| o8_spec_read | 72301 | 14221 | 7 | 14221 |
| o8_packet_diff | 68910 | 14181 | 6 | 14181 |
| o8_task_list | 21227 | 11406 | 3 | 16780 |
| get_packet_scope | 21807 | 10456 | 3 | 17130 |
| o8_threads_list | 69808 | 11109 | 11 | 17706 |
| o8_list_repos | 115 | 115 | 1 | 115 |
| o8_operator_defaults | 6746 | 6746 | 1 | 6746 |

A status call returned an environment-dependent error and was excluded from the
successful-call size comparison. Native-only tools and external model actions
were not invoked. Image blocks retain their typed representation and receive an
added summary; their image bytes are not paged. The native read transport was not
changed or benchmarked.

## Reading a large result

Text-only results use a 19000-byte payload budget to keep the full response below
20000 bytes. Larger results return `o8/mcp/result-page/v1`, with a summary,
sourceTool, text, totalBytes, resultId, expiresAt, and nextArguments. The first
page is returned by the source tool. For every non-null nextArguments value,
call `o8_result_page` using those arguments exactly. Concatenate text in order,
then parse JSON to reconstruct the original MCP result, including its content
blocks and isError flag. A tool's own truncation metadata, such as a diff budget,
stays intact.

```text
o8_spec_read({repoPath:"/path/to/repo"})
o8_result_page({resultId:"id-from-nextArguments", offset:12000})
```

The offset is a UTF-16 text position supplied by the server. Read offset 0 to
replay a saved first page. Continuation reads do not invoke the source handler;
this also applies to large mutation receipts. Do not repeat an action to fetch
its next page.

The process cache holds at most 32 results and 32 MB, for five minutes. Route
recompilation preserves the cache. Restart, expiry, and eviction invalidate saved
identifiers. A result larger than the total cache limit returns an explicit
summary with truncated:true. Cached access requires the original data profile,
request profile, device context, and current access to the source tool. Invalid
or expired cursors explain how to recover without blindly repeating a mutation.

## Verification

The failing route test observed 92118 bytes for a normal large spec response.
The fix keeps every page under 20000 bytes, including quotes, backslashes and
non-ASCII text. Tests reconstruct the original content, preserve small response
shapes, exercise expiry and a large gate refusal, reject profile expansion, and
prove a persisted annotation is applied once when its receipt is paged.
Four stable live responses reconstructed exactly against baseline. Thread
snapshots contain changing observation metadata, so independent before/after
snapshots were not byte-identical. All eleven thread pages were read successfully.
