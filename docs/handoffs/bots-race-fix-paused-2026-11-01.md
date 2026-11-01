# Paused bot thread-race handoff — 2026-11-01

Implementation, tests and reviews are paused. This cleanup preserves the already-written
race correction and its already-generated classification metadata. No new functional
development or verification was run during cleanup. These are preservation snapshots,
not merge-ready or fully verified corrections.

## Exact saved candidates

| Slice | Published before cleanup | Previously checked local candidate | Candidate tree |
| --- | --- | --- | --- |
| PR5 / #5233 | 6d5121e59add09b99dceeb0ac6c1fd2f1ecbf3b9 | ceaee0f179339dc5533845f2002b74bdbeed15c9 | c50fa0dac015d5759f2627c7dbc3dcd7cc5b6600 |
| PR7 / #5238 | 91d204d017201dc7b9837ca73081fea7ad0579c6 | bcbc368600851f03a265235bc0c3c42c874f8997 | 560f6822be3f170040f2b174a06ef514eeb9bc2d |

The saved generated metadata adds only `stdio-json-rpc-peer` to the existing
`tests/bot-network-thread-real-path.test.ts` classification. Cleanup commits:
PR5 `c96e97b66a8c7a97f6f6699915b799162a378bc5`;
PR7 `3df26edf7e8ec2645277a7abab021132ed3baf0b`.
The metadata was committed without rerunning classification.

## Preserved correction and prior evidence

Native composition associates its existing thread with bus admission before delivery.
MCP binding recovers an accepted, unassociated native intent before creating another thread.
The two production-route/independent-stdio race and database-reopen regressions failed on
both published heads above and passed with the saved correction.

Prior completed checks: PR5 network integration 34; PR7 network/question integration 40;
focused units 33; legacy bus/Inbox integration 37; native network 7; native questions 3.
Counts overlap. The source correction and regressions received functional inspection;
no further review was run during cleanup. Local detailed logs and source bundles remain
preserved separately.

## Unfinished verification and known limits

- Classification initially failed only for the missing stdio metadata. The saved generated
  patch is now committed and carried, but its final classification check remains unrun.
- The hermetic gate was interrupted on request (SIGTERM, exit -15); there is no completed
  full-suite result for this correction.
- Typecheck retains the independently reproduced baseline TS2345 at
  `tests/inbox-settlement.integration.test.ts:150`.
- Earlier baseline evidence includes the Linux Secret Service fixture round-trip failure.
- The reviewer independently reproduced
  `tests/composer-queue-retry-real-path.test.ts:107:47`,
  “retries a lost API receipt after renderer and database restart without creating another
  delivered turn,” on base `1039a196c5d6c13e1c1aadab6455e4e88fe7e378` and the old PR7 head.
  Its empty text/wireMessage/images result is unrelated and was left unchanged.
- Already-forked databases still need separate reconciliation. This patch prevents new
  forks and recovers preassociation interruptions; it does not repair existing duplicate
  thread records.
- Real Claude/Grok execution remains unverified; the prior proofs use scripted local
  protocol clients. Full native suite and live GUI were not run.

All drafts retain their inherited merge/security hold. No merges, approvals, protected
branch updates, closure of #5206, Settle/park work, PR6 hosted delivery or PR8 bridge work
are authorized by this handoff. Claude owns subsequent orchestration, review and merging.

