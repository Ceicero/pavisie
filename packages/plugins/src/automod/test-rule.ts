// Dedicated flat re-export so apps/api can reach `testRuleWithText` via the package's generic `"./*"` subpath
// export (`@pavisie/plugins/automod/test-rule`) without needing an explicit `"./automod"` entry in
// packages/plugins/package.json (out of this task's ownership — see apps/api/src/routes/automod.ts's `POST
// rules/:id/test`, which is the only consumer).
export { testRuleWithText } from './engine';
export type { EvaluatorResult } from './engine';
