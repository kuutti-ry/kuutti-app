// The demo tools of #73 (ADR-014), as `@kuutti/db/demo`: the personas of the
// mock bank, the synthetic population and its writer. A door of its own, on
// purpose: the API imports `@kuutti/db`, and nothing here belongs on its
// import graph or in its image. Command lines and tests come in here.

export { renderBankPage } from "./bank-page.ts";
export {
  assertDemoTarget,
  assertStagingProcess,
  DEMO_ENVIRONMENTS,
  type DemoCommand,
  DemoCommandError,
  type DemoEnvironment,
  type DemoTarget,
  describeTarget,
  NEVER_GIVEN_ON_STAGING,
  parseDemoCommand,
} from "./command.ts";
export {
  OLDER_TERMS_VERSION,
  PERSONA_HISTORIES,
  type PersonaHistory,
  personaOf,
} from "./histories.ts";
export {
  assertArtificial,
  DEMO_PERSONAS,
  type DemoPersona,
  hasFixedIdentity,
  MOCK_BANK_ACR,
  MOCK_BANK_AMR,
  personaBirth,
  personaClaims,
  personaHetu,
} from "./personas.ts";
export {
  type AssetProblem,
  assetsFor,
  demoAssetsDir,
  facesForPopulation,
  manifestOf,
  negativesOf,
  PHOTOS_RELEASE,
  PHOTOS_REPO,
  type PhotoAsset,
  type PhotoPurpose,
  purposeOf,
  renderManifest,
  verifyAssets,
} from "./photos.ts";
export { PHOTOS_MANIFEST } from "./photos-manifest.ts";
export {
  apportion,
  DEMO_EPOCH,
  DEMO_LABEL_PREFIX,
  DEMO_SEED,
  DEMO_SIZE,
  DEMO_SIZE_MAX,
  generatePopulation,
  NEVER_ONBOARDED_SHARE,
  POND_PLANS,
  type PondPlan,
  type PopulationOptions,
  plannedPonds,
  planSizes,
  type SyntheticPerson,
  type SyntheticProfile,
  summarise,
  type Thresholds,
  uncrossed,
} from "./population.ts";
export { everyText } from "./words.ts";
export {
  type ConsentVersions,
  DEMO_SUBJECT_PREFIX,
  deleteIdentities,
  demoHetuHmac,
  type RemoveResult,
  removePopulation,
  type WriteResult,
  writePopulation,
} from "./write-population.ts";
