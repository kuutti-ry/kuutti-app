import type { PhotoAsset } from "./photos.ts";

// Written by `pnpm demo:assets -- --manifest <dir>` from the pictures of
// release v1 of kuutti-ry/kuutti-app-demo-photos (#142, ADR-014 §7): every
// file's path, SHA-256 and purpose. The pictures themselves are never in this
// repository; a test refuses a binary under packages/db/src/seed. Empty until
// the release exists: with no entry, no persona and nobody of the population
// gets a photo, and the commands say so.
export const PHOTOS_MANIFEST: readonly PhotoAsset[] = [
  {
    path: "faces/aino/1.jpg",
    sha256: "913844ee6195d3fd24c08d82196e135856d3b0506f5f82b9e6d1dc14cd10f687",
    purpose: "persona:aino",
  },
  {
    path: "faces/aino/2.jpg",
    sha256: "d36a6b539da32c0c430193c2774c15501da94c3ad1ceb231f2e72024ace9409f",
    purpose: "persona:aino",
  },
  {
    path: "faces/aino/3.jpg",
    sha256: "7529d3ff323489370fe959c2a2d5b88336cae720de0dbeba11035a7cac067900",
    purpose: "persona:aino",
  },
  {
    path: "faces/aino/4.jpg",
    sha256: "ab20097d1107b93d00a525d3d8889ceba67eb20e55f9b23b207a6cd97a4a9d99",
    purpose: "persona:aino",
  },
  {
    path: "faces/aino/5.jpg",
    sha256: "92bdf52b4b1b070f3da8edaed2f9d2c696ef78cb87817bee4d72da5daba642ed",
    purpose: "persona:aino",
  },
  {
    path: "faces/ilona/1.jpg",
    sha256: "b5bc38a6ec4ae9a16093ca56d571aad640871a33545ba33f19158da14206191b",
    purpose: "persona:ilona",
  },
  {
    path: "faces/ilona/2.jpg",
    sha256: "042544806c07547a5c254b3be40b3b83337074dae6371a56679eb0c1574ed994",
    purpose: "persona:ilona",
  },
  {
    path: "faces/ilona/3.jpg",
    sha256: "79e5889841cdf046e1d695a30ff318990e2f521196d7cd766840df680647f4dc",
    purpose: "persona:ilona",
  },
  {
    path: "faces/kerttu/1.jpg",
    sha256: "951b63dfa6bc0b850560ce8147db92bc4885d52ff1a447aafd6c1bdb70ef3301",
    purpose: "persona:kerttu",
  },
  {
    path: "faces/kerttu/2.jpg",
    sha256: "a65cafa0be4d863bda3da8253f5b3fc4c6ee814193752330d1ade5d9aeccca72",
    purpose: "persona:kerttu",
  },
  {
    path: "faces/kerttu/3.jpg",
    sha256: "d3a8b0f2dd9d338029859f416164e0232c80febdc8d66d3a9a9c147aa59e0bd3",
    purpose: "persona:kerttu",
  },
  {
    path: "faces/kerttu/4.jpg",
    sha256: "add14c1358ac6aff3d7dac77b5ed92a01f3fb86a6165e66f8cc6bc396149d71d",
    purpose: "persona:kerttu",
  },
  {
    path: "faces/mikael/1.jpg",
    sha256: "3362fe47bb07334e58ab45508a3f8a3840ce777c0dc99c256cffa59f196643bd",
    purpose: "persona:mikael",
  },
  {
    path: "faces/mikael/2.jpg",
    sha256: "15b9cd25f8a1a6c543f95cef27b48d346f4a5c5f78cf1d5c240eb47bd4a0d66c",
    purpose: "persona:mikael",
  },
  {
    path: "faces/mikael/3.jpg",
    sha256: "9c2a0c290e98c7a3159beee8fdd223a5dce1bf0584014431bcef7e289f865120",
    purpose: "persona:mikael",
  },
  {
    path: "faces/mikael/4.jpg",
    sha256: "f5bb90f4a96b4dbf2a623251923e751da100b0dfcc427382ed9a675869d93358",
    purpose: "persona:mikael",
  },
  {
    path: "faces/noa/1.jpg",
    sha256: "d7a99d3b10260d642e2909a1e310549cb8c0191604e3dafa723556fe37fa5c15",
    purpose: "persona:noa",
  },
  {
    path: "faces/noa/2.jpg",
    sha256: "ec68dfeddc7fd52fda795dce7d79b868e19dbc5ab03604d0d3447cd645934c68",
    purpose: "persona:noa",
  },
  {
    path: "faces/onni/1.jpg",
    sha256: "ede38db1653c62db114e0cb7bfbab61c4c12ade4e6ddba8612cca4f373967ad0",
    purpose: "persona:onni",
  },
  {
    path: "faces/onni/2.jpg",
    sha256: "24a19487f69d2d95b624a7fddeba828859ecd501fb17e581b0d13dd4043ffa93",
    purpose: "persona:onni",
  },
  {
    path: "faces/onni/3.jpg",
    sha256: "f5c39e9bec8e9bb793d9dbcac4981f294125925bf2ed2bc6297e2e8d9775ee70",
    purpose: "persona:onni",
  },
  {
    path: "faces/onni/4.jpg",
    sha256: "d9adf72bca7a4418ce733c549a1a436859517ef45f4ab01e3fb015bfd1cb37dd",
    purpose: "persona:onni",
  },
  {
    path: "faces/onni/5.jpg",
    sha256: "bd31f6844ab2a31c6d2ffb56f98853240ab872fc43ffc7df0e12b4bdfa0374f2",
    purpose: "persona:onni",
  },
  {
    path: "faces/onni/6.jpg",
    sha256: "36b8ba11bf63b0300fa5a7616eb37b95a3256a7e19cf4aa6ea52bb9bf0187dbf",
    purpose: "persona:onni",
  },
  {
    path: "faces/onni/7.jpg",
    sha256: "c82f47e20d4d20ba4a92724038f98b0ff19a460c1b61336ba5cc5dc69a99a531",
    purpose: "persona:onni",
  },
  {
    path: "faces/onni/8.jpg",
    sha256: "1fc1bbbd375a9b25ae1465c88352f7523b3cdf989e6e8591892cc6d3698da99a",
    purpose: "persona:onni",
  },
  {
    path: "faces/sanna/1.jpg",
    sha256: "b759795efd73c0a48f4aaf759baaba7fe22b8e163e10bec209e7977f54d7ddf8",
    purpose: "persona:sanna",
  },
  {
    path: "faces/sanna/2.jpg",
    sha256: "1fb09836ea3af8642c9747fcc83f15794d1fa74e791a3a8ddcb5a49b42cbf48c",
    purpose: "persona:sanna",
  },
  {
    path: "faces/sanna/3.jpg",
    sha256: "b872a55eda8e1a82eb3b2b046f5964bb858026aa939cc8e9221ec48252b6b1d1",
    purpose: "persona:sanna",
  },
  {
    path: "faces/sanna/4.jpg",
    sha256: "ee967f3b9ed0e5cc848a0b112c0aff6fee4557ffdd2af676dbb4ec10486b00eb",
    purpose: "persona:sanna",
  },
  {
    path: "faces/sanna/5.jpg",
    sha256: "f9605f7285fdee653fbdc716ecac812b610f4e37b72872ad2982bbd5c6461823",
    purpose: "persona:sanna",
  },
  {
    path: "faces/tapio/1.jpg",
    sha256: "69bbe99a6220bd220e506e3eaf6eac618e0cd04aec07f9016ee0691a95ffc1c8",
    purpose: "persona:tapio",
  },
  {
    path: "faces/tapio/2.jpg",
    sha256: "c2a38e1a6f0bf5db671e37880dba31eb8bd6107c3531b911ef53fc6e8a2ae703",
    purpose: "persona:tapio",
  },
  {
    path: "faces/tapio/3.jpg",
    sha256: "266c5791f65b1e4b0b3a77843e04107a88c9c7285619e38edd69ff21d8661fb3",
    purpose: "persona:tapio",
  },
  {
    path: "negatives/exif-location.jpg",
    sha256: "e205f1dff627ea167cffa2064529700fb31a04bb1b40f1ce63071da16efad290",
    purpose: "negative:exif-location",
  },
  {
    path: "negatives/no-face.jpg",
    sha256: "b7e88e37a9758100244482a303537b9a45e28595fc0d3184965390e690263122",
    purpose: "negative:no-face",
  },
  {
    path: "negatives/several-people.jpg",
    sha256: "eacf619dfb293d68db56c0832e0ea5248b8668993c5f337405cf1b55efc1ed24",
    purpose: "negative:several-people",
  },
  {
    path: "negatives/text.jpg",
    sha256: "c7104ec325e506cecd64a9da3ebc5fe5e5e493efabe18e0d4e8872818eafb398",
    purpose: "negative:text",
  },
];
