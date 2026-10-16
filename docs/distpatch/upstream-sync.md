# Upstream sync policy

## Baselines

- M0 audit baseline: `developerz-ai/multi-ai-router@6d30948d560b4df2dab56be31879c143ddb24223` (`v2.39.2`)
- Genuine fork created at: `itsmrshow/distpatch@903b486683b6d4072debd5e8bd607bc12d87242f` (`v2.39.3`)
- Relationship: `903b486...` is exactly one upstream commit newer and directly parents from `6d30948...`.

M0 documentation is published from the current fork `main`; **never reset or rewrite `main` back to the older audit SHA**.

## Remote policy

```text
origin   -> itsmrshow/distpatch
upstream -> developerz-ai/multi-ai-router
```

Never push Distpatch changes to `upstream`.

## M0 branch

`audit/m0-upstream-baseline` is documentation/project metadata only. It must contain no runtime behavior changes.

## Future sync procedure

1. Fetch `upstream/main`.
2. Record the full upstream SHA before beginning a milestone.
3. Create an isolated feature/audit branch from current Distpatch `main`.
4. Inspect upstream changes touching providers, auth, routing, quota, translation, DB migrations and security boundaries.
5. Rebase/merge deliberately and run the full upstream gate before treating the sync as complete.
6. Update Distpatch-specific audit notes when an upstream change alters an architectural assumption.

Distpatch should preserve working upstream functionality and keep divergence narrow.