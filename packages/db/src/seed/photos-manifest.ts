import type { PhotoAsset } from "./photos.ts";

// Written by `pnpm demo:assets -- --manifest <dir>` from the pictures of
// release v3 of kuutti-ry/kuutti-app-demo-photos (#142, ADR-014 §7): every
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
    path: "faces/henna/1.jpg",
    sha256: "3081323f1762933acbb53cfd3f7436960a172037382098f91ed7ae3a67bb321e",
    purpose: "persona:henna",
  },
  {
    path: "faces/henna/2.jpg",
    sha256: "1dae5db5959cb49223bed3ced110f7d665b6a9b1934a07449ac23cc95cb26618",
    purpose: "persona:henna",
  },
  {
    path: "faces/iida/1.jpg",
    sha256: "b44959e5cad9a2f217e71cd64f605491e1ce9549961a8336f8dd8e5b2de74d4d",
    purpose: "persona:iida",
  },
  {
    path: "faces/iida/2.jpg",
    sha256: "921354cf53811b2a1eccd4de37a8b516b6c93cf1168cacf79c765e8a1f6292d4",
    purpose: "persona:iida",
  },
  {
    path: "faces/iida/3.jpg",
    sha256: "8b2175914879ac203da0e76b28f19ed593b55d1248b4f140dbb8d91f1c0bd0fa",
    purpose: "persona:iida",
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
    path: "faces/katja/1.jpg",
    sha256: "68a028a7be1ed378096b5a5b9d019ac90a6d9e37e77cd9a5ab8afc94a7f655d2",
    purpose: "persona:katja",
  },
  {
    path: "faces/katja/2.jpg",
    sha256: "841841c7cceb7c8cc01326103c04115a89e4cf35d7e7e5eefb8f36187be41177",
    purpose: "persona:katja",
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
    path: "faces/minna/1.jpg",
    sha256: "71cab2f39bd89d508914b575c25188b10514f41c4b1bc0b01c2b68a36563be32",
    purpose: "persona:minna",
  },
  {
    path: "faces/minna/2.jpg",
    sha256: "f16d9e5e977cf31f774e44f62c50c7b21b9338444352bc6054317f749591f2dc",
    purpose: "persona:minna",
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
    path: "faces/riikka/1.jpg",
    sha256: "13ff46ae0db3f6ed398ac7fe3ac15df3ab0c995e6df7a71af2926d855eb516d3",
    purpose: "persona:riikka",
  },
  {
    path: "faces/riikka/2.jpg",
    sha256: "e28231754deee1b0ecaeabaa7e0eafbdc88ab5aaf31e34ad769ff5fb444b01b7",
    purpose: "persona:riikka",
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
    path: "negatives/aubergine.jpg",
    sha256: "1239fd79294903b5dc9f30b12e7c85cfca3b2ed6d1e4fae9dc3c19beac394a5c",
    purpose: "negative:aubergine",
  },
  {
    path: "negatives/beer.jpg",
    sha256: "5bab6ddf692156055f89e37d76e42721ffb3bc83babee27dfcb286d1947904f2",
    purpose: "negative:beer",
  },
  {
    path: "negatives/exif-location.jpg",
    sha256: "e205f1dff627ea167cffa2064529700fb31a04bb1b40f1ce63071da16efad290",
    purpose: "negative:exif-location",
  },
  {
    path: "negatives/finger.jpg",
    sha256: "5d84ae45d1215e957ab42eb68c0be3da2055eaf77b3455d7830ee0a7fb135409",
    purpose: "negative:finger",
  },
  {
    path: "negatives/fish.jpg",
    sha256: "c709cd424dd18d95c787cabbc802c319c2bcb95c6e70f79c9589bee6f253122e",
    purpose: "negative:fish",
  },
  {
    path: "negatives/halloween.jpg",
    sha256: "172c4799580983bb4d0c026b4077abc24a0f0b2c86e15708906f5559581d28f6",
    purpose: "negative:halloween",
  },
  {
    path: "negatives/market.jpg",
    sha256: "481004d73c864c1be9558f34138cba891700a574ccf18d84d9053b57161bb3a7",
    purpose: "negative:market",
  },
  {
    path: "negatives/mirror.jpg",
    sha256: "f1c6d0314880ef926ff4804da93e918c55a62ca9fe4ade955c6a43d4765a2d33",
    purpose: "negative:mirror",
  },
  {
    path: "negatives/no-face.jpg",
    sha256: "b7e88e37a9758100244482a303537b9a45e28595fc0d3184965390e690263122",
    purpose: "negative:no-face",
  },
  {
    path: "negatives/rifle.jpg",
    sha256: "da370ad7a8ee87ffa3d374f45e38b34490713a039292576a9f29e85d57b88725",
    purpose: "negative:rifle",
  },
  {
    path: "negatives/sauna-porch.jpg",
    sha256: "830884b7bb7f9e37956b28e0fa305dfdb3441621d62ebd47a004f6d9fe1e1546",
    purpose: "negative:sauna-porch",
  },
  {
    path: "negatives/sauna-towel.jpg",
    sha256: "1b5cf3eff04e74c67a706cc9856f460d89f9dd26a030ef29c7e7b62c0f336616",
    purpose: "negative:sauna-towel",
  },
  {
    path: "negatives/several-people.jpg",
    sha256: "eacf619dfb293d68db56c0832e0ea5248b8668993c5f337405cf1b55efc1ed24",
    purpose: "negative:several-people",
  },
  {
    path: "negatives/shirtless.jpg",
    sha256: "1bd21678ce216ffbf5b5069ebb4da1b77a2ed73c4669d1bebeb0d3a295e50660",
    purpose: "negative:shirtless",
  },
  {
    path: "negatives/sunglasses.jpg",
    sha256: "47a27cf9c1f322c5d180f58d5895a4f311d4a55adc02470c3994d7a5e5e17e32",
    purpose: "negative:sunglasses",
  },
  {
    path: "negatives/swimsuit.jpg",
    sha256: "ef39f35c4946f5ce83ff89cb0f25d2d9be05ae2e016c1098e4f50e2bf78f71ae",
    purpose: "negative:swimsuit",
  },
  {
    path: "negatives/text.jpg",
    sha256: "c7104ec325e506cecd64a9da3ebc5fe5e5e493efabe18e0d4e8872818eafb398",
    purpose: "negative:text",
  },
];
