import type { PhotoAsset } from "./photos.ts";

// Written by `pnpm demo:assets -- --manifest <dir>` from the pictures of
// release v4 of kuutti-ry/kuutti-app-demo-photos (#142, ADR-014 §7): every
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
    path: "faces/cast/aada/1.jpg",
    sha256: "ee4390d74eddfae41dbe8c8636315e7a915ae01e89980c65575b8af3316a105f",
    purpose: "cast:aada",
  },
  {
    path: "faces/cast/aada/2.jpg",
    sha256: "fdd03a5ae0fb10e747a69dc148430e22acd5547d19cf154414fea32bd1edacc9",
    purpose: "cast:aada",
  },
  {
    path: "faces/cast/aada/3.jpg",
    sha256: "c16b24e6a5244fb571c0d5eedaa8d5e2c63c7795404062b34d69377ed0b5f236",
    purpose: "cast:aada",
  },
  {
    path: "faces/cast/abdi/1.jpg",
    sha256: "ae418a515c794730de04ccbde58255c6a3762e7e0ac6788676a8aa0c15a3af03",
    purpose: "cast:abdi",
  },
  {
    path: "faces/cast/abdi/2.jpg",
    sha256: "4ec4e72bd8b7a1c5a00c4a6cc697755c3bc3e908f8d287bbc05a497af45b3985",
    purpose: "cast:abdi",
  },
  {
    path: "faces/cast/abdi/3.jpg",
    sha256: "b54c3d1df179fc018ec9246b9ae251921109a48234ca53692e65ef0fd3925d8d",
    purpose: "cast:abdi",
  },
  {
    path: "faces/cast/aleksi/1.jpg",
    sha256: "803db9a5f6b8e54f01a1612efe9f92190402a1ef3b6e245dcd0ad0e901dc3d77",
    purpose: "cast:aleksi",
  },
  {
    path: "faces/cast/aleksi/2.jpg",
    sha256: "ddfa693efe93d3f27acc8f9f775e3ef0f6207d2504838906e6f25705da3037df",
    purpose: "cast:aleksi",
  },
  {
    path: "faces/cast/aleksi/3.jpg",
    sha256: "3bee6f50f8f3ccab59565eaa612bebdf1ad4e8936eea9fc70ca782c3a70f6381",
    purpose: "cast:aleksi",
  },
  {
    path: "faces/cast/alina/1.jpg",
    sha256: "c5c6f0fdfcb817ec0f0feb3d0f0566e69aee68d558292b9fce8a27e8bfbd37d5",
    purpose: "cast:alina",
  },
  {
    path: "faces/cast/alina/2.jpg",
    sha256: "95aa84f28ce629cd44488bc082501c01c8b6faeeef74af10c91ee93927f9adfb",
    purpose: "cast:alina",
  },
  {
    path: "faces/cast/alina/3.jpg",
    sha256: "6ddeda6ffebec1caf97ed1f9af3cf1327aadba95479371c8bacf6810a1b70fee",
    purpose: "cast:alina",
  },
  {
    path: "faces/cast/anders/1.jpg",
    sha256: "ec6a6174e35669e497fe61ea66f5a7a0856ad00870bc06b339d459e8d9439331",
    purpose: "cast:anders",
  },
  {
    path: "faces/cast/anders/2.jpg",
    sha256: "07f2be1fbdea3d675d0bd3ddb60236b45f29d8fb1306ba0ec0992371f429d566",
    purpose: "cast:anders",
  },
  {
    path: "faces/cast/anders/3.jpg",
    sha256: "36b56d298c60c8dcb85f6dc99805850739207153ff568d6302990dcdf43090c4",
    purpose: "cast:anders",
  },
  {
    path: "faces/cast/antero/1.jpg",
    sha256: "67cbab7eeef11ee908d7790835c06d6bb7587c5aa68ef0d95c6c81c3687404e2",
    purpose: "cast:antero",
  },
  {
    path: "faces/cast/antero/2.jpg",
    sha256: "fc0275ddc2d9c332c65085dc14fa0d53cae10a535968d2f01c1872e49788280f",
    purpose: "cast:antero",
  },
  {
    path: "faces/cast/antero/3.jpg",
    sha256: "a4aeec8bfbd0f78c160c5a30a9f13b9cee369e9a23dfcaf32ed0966924541f03",
    purpose: "cast:antero",
  },
  {
    path: "faces/cast/ari/1.jpg",
    sha256: "2fc151dc76b34250ded18f28947e83b82648ce71bbf5a5926da1c97b54d270ea",
    purpose: "cast:ari",
  },
  {
    path: "faces/cast/ari/2.jpg",
    sha256: "a8171cfd9f22a2fb2b2222be8d95c2b1f82e350d5ccba6c3caa3e9be0fd05eab",
    purpose: "cast:ari",
  },
  {
    path: "faces/cast/ari/3.jpg",
    sha256: "d06e61fdbccfe974c549a174bea24943dfda5905c308d234399aaf8c4850eb8e",
    purpose: "cast:ari",
  },
  {
    path: "faces/cast/dmitri/1.jpg",
    sha256: "7450925fb089d395e1cb25b6bba50b2956e081496dd142710de03b2ec05f3697",
    purpose: "cast:dmitri",
  },
  {
    path: "faces/cast/dmitri/2.jpg",
    sha256: "41dcadf1eacc513f705eff69677a1a0e9fd18a7ac6f67e2ebb8568e3c83463d2",
    purpose: "cast:dmitri",
  },
  {
    path: "faces/cast/dmitri/3.jpg",
    sha256: "6028dac056426749bfb5c9413230af70844975a54795488f47d8f589adb46599",
    purpose: "cast:dmitri",
  },
  {
    path: "faces/cast/eemil/1.jpg",
    sha256: "d4452eff693a05bd9b2fb6016afa96c53a64bff655bba42d0ec66d34290aa2c3",
    purpose: "cast:eemil",
  },
  {
    path: "faces/cast/eemil/2.jpg",
    sha256: "7f5f74777a9a71d948cc2c5ab14a85c7a8eec405b12f14fc9592315462ba0c80",
    purpose: "cast:eemil",
  },
  {
    path: "faces/cast/eemil/3.jpg",
    sha256: "1ec6805c83762e3fbbae6b3a6177b44d8a9b8c74d85c4d087a6dab01478b7613",
    purpose: "cast:eemil",
  },
  {
    path: "faces/cast/elias/1.jpg",
    sha256: "5dc1eb5010641e3c9d07a085693e24654380fcece6101c1b96f8f704bfe7d826",
    purpose: "cast:elias",
  },
  {
    path: "faces/cast/elias/2.jpg",
    sha256: "07cf2ee3307cc087f7b32d44faf6cc0cc3bbf11a3b7be663f50fa758aeae9fda",
    purpose: "cast:elias",
  },
  {
    path: "faces/cast/elias/3.jpg",
    sha256: "b413577eb2f7b72764b030e4e547276f88b3c29a2ac9f3c330877d829ca174f4",
    purpose: "cast:elias",
  },
  {
    path: "faces/cast/emilia/1.jpg",
    sha256: "4fcee1314b59e031b749458662c1d21524921fd55921c47f7a4bce0ddbd0ef1a",
    purpose: "cast:emilia",
  },
  {
    path: "faces/cast/emilia/2.jpg",
    sha256: "03697dc8d4a5c218a558128bc3943ff68ba179938b513aafd3e99745942fa444",
    purpose: "cast:emilia",
  },
  {
    path: "faces/cast/emilia/3.jpg",
    sha256: "9d8c5f98db8fde567304b1c6c130692122b678a43653c8c1de8ef91e664dee86",
    purpose: "cast:emilia",
  },
  {
    path: "faces/cast/esa/1.jpg",
    sha256: "f6bb29e1d9739f2febf202a0fb76beb6e45d752da6be48ec0c74c345afad9452",
    purpose: "cast:esa",
  },
  {
    path: "faces/cast/esa/2.jpg",
    sha256: "fa9c5a43f7dc345fc565003350722c2456e82bd35fd00d40c150c162dd3610ae",
    purpose: "cast:esa",
  },
  {
    path: "faces/cast/esa/3.jpg",
    sha256: "7c4cf97d4bd6c55572554bbf6ec99b1926c81f9d7e7a94368f049456cbe3e4a7",
    purpose: "cast:esa",
  },
  {
    path: "faces/cast/fanni/1.jpg",
    sha256: "a914c3c36ee3a8401eed8085692652a264156b17f798fe76169715e399deb27d",
    purpose: "cast:fanni",
  },
  {
    path: "faces/cast/fanni/2.jpg",
    sha256: "8de72458e9024a26e33b7c319effe35f9faae0a8db4a1336683dd652619e44c5",
    purpose: "cast:fanni",
  },
  {
    path: "faces/cast/fanni/3.jpg",
    sha256: "d0334bc16132f2bf008f409291f82a31273cdc0f6d56baa6d18bc154d4a7a86c",
    purpose: "cast:fanni",
  },
  {
    path: "faces/cast/harri/1.jpg",
    sha256: "09cd65d7b4e90d0540b5ad03b84f8cdf117ba2f3d525ad189afb7657821bfd53",
    purpose: "cast:harri",
  },
  {
    path: "faces/cast/harri/2.jpg",
    sha256: "ec11c7ef93d2fcc952b3e55d072ca28cfec401f19756e9f4863823ee6063c3fb",
    purpose: "cast:harri",
  },
  {
    path: "faces/cast/harri/3.jpg",
    sha256: "a0f3152bb1a60343f24418e6a67a7fc8968738dc2b09fdbc45161a136236f0b5",
    purpose: "cast:harri",
  },
  {
    path: "faces/cast/janne/1.jpg",
    sha256: "9f9e4311476de8d7bfc7409c74e0ab067d6735fb43b9a1c288721b2589af5e76",
    purpose: "cast:janne",
  },
  {
    path: "faces/cast/janne/2.jpg",
    sha256: "6832e86cf5169e13a9e07d2c4e457b293c3c0f85e8401e487cc38b6b2c3241cd",
    purpose: "cast:janne",
  },
  {
    path: "faces/cast/janne/3.jpg",
    sha256: "477ab98147a58a9090fa0f245e2a9c48d99a5ea07bb45f62487f1ee8c0c80079",
    purpose: "cast:janne",
  },
  {
    path: "faces/cast/jere/1.jpg",
    sha256: "6fb685ad97dc6ce35fe75e0cb59c9e043632507dcbe8e5069b7e565819ba6077",
    purpose: "cast:jere",
  },
  {
    path: "faces/cast/jere/2.jpg",
    sha256: "a95f6b812747c56013742e19e809883fa547ddc71f206c79b601911fa2a59c72",
    purpose: "cast:jere",
  },
  {
    path: "faces/cast/jere/3.jpg",
    sha256: "fd556606307b4536c6b38c1858dbcccb232268a47aa78df7597160068db832d3",
    purpose: "cast:jere",
  },
  {
    path: "faces/cast/joonas/1.jpg",
    sha256: "dc9004032e57b1fa600d910258e67154f135def0089c54c0178ead60cdff64ec",
    purpose: "cast:joonas",
  },
  {
    path: "faces/cast/joonas/2.jpg",
    sha256: "a3e7dad981a80920023d94c6a1df04872a155ce76fd3fa6e96719c3b15b88694",
    purpose: "cast:joonas",
  },
  {
    path: "faces/cast/joonas/3.jpg",
    sha256: "e54e59b125edfe3188646ec3935f7ca3120b1c31633a48a8edd5784e6221053b",
    purpose: "cast:joonas",
  },
  {
    path: "faces/cast/juha/1.jpg",
    sha256: "fcc1748b4dad0c733560b1501fd55e9f6f9729428627a915488d8ffaccd3b5de",
    purpose: "cast:juha",
  },
  {
    path: "faces/cast/juha/2.jpg",
    sha256: "f31413b72fc906e1883ec112a68042d06469e09fca59c808f8a2774f08ebe398",
    purpose: "cast:juha",
  },
  {
    path: "faces/cast/juha/3.jpg",
    sha256: "d9d6b75e32db652ce1706e4a9f8122bfbf2efa4479b4f43ece9ce290cb2bc1c5",
    purpose: "cast:juha",
  },
  {
    path: "faces/cast/kalle/1.jpg",
    sha256: "9f64f990536669fd9349ac511a56719dd8dbcf8272258b1096e00c0c21fad50b",
    purpose: "cast:kalle",
  },
  {
    path: "faces/cast/kalle/2.jpg",
    sha256: "2af571b7bedb477e590907c619dfd7f20825ec5bb9092c4b089fc86f77ea283d",
    purpose: "cast:kalle",
  },
  {
    path: "faces/cast/kalle/3.jpg",
    sha256: "f8cb4a3cb8353256d0e2e30155a7fc6a34c705570f7cfb8690ba55db7afe0603",
    purpose: "cast:kalle",
  },
  {
    path: "faces/cast/karim/1.jpg",
    sha256: "c82649c94656b2f698c8a715d8519eea7037a6aac30c99ee3dfd74504207c0dc",
    purpose: "cast:karim",
  },
  {
    path: "faces/cast/karim/2.jpg",
    sha256: "d93e9fb8b71446a18a1c513f8610d5a0239a549ac27a99743fcf02ba789e70f5",
    purpose: "cast:karim",
  },
  {
    path: "faces/cast/karim/3.jpg",
    sha256: "0d1589659367e5c9b4c1c1a034b0a565219e0292c8cfe1bfce35945476465eee",
    purpose: "cast:karim",
  },
  {
    path: "faces/cast/lasse/1.jpg",
    sha256: "9ddabb70693e5f346d5d1ddc32e74ad8f3269ec857c6e892d050ee2bbc640304",
    purpose: "cast:lasse",
  },
  {
    path: "faces/cast/lasse/2.jpg",
    sha256: "617cd698ad303497cf20f6fd8e3f2984c16cd1a90567fb30e981cdfab06411e8",
    purpose: "cast:lasse",
  },
  {
    path: "faces/cast/lasse/3.jpg",
    sha256: "e55cca07cffac049bbac7e0a195ed9206817b83fee0855e303eaef42c0b212aa",
    purpose: "cast:lasse",
  },
  {
    path: "faces/cast/leena/1.jpg",
    sha256: "eec8719e0162f9932d8297ae125325e4b78ec72c9044b2bedcc8f56ead8e0f0f",
    purpose: "cast:leena",
  },
  {
    path: "faces/cast/leena/2.jpg",
    sha256: "a69cb2a3ed40791c42eb646aaad11895dcc6854c71fcde28fa7f5bf6fee3a820",
    purpose: "cast:leena",
  },
  {
    path: "faces/cast/leena/3.jpg",
    sha256: "81dc9dffb3350de5ac3dea12d7d5d4bdb9f7bfd9e7608e956df92d5ca4cace4d",
    purpose: "cast:leena",
  },
  {
    path: "faces/cast/lotta/1.jpg",
    sha256: "3abb8ba6f07a258d190483e662923cf7f24a2007b330f293e63673561405f728",
    purpose: "cast:lotta",
  },
  {
    path: "faces/cast/lotta/2.jpg",
    sha256: "698c9facc199aa92e0ffdcb582a68820d678a4105502385759b09d5151ced1cf",
    purpose: "cast:lotta",
  },
  {
    path: "faces/cast/lotta/3.jpg",
    sha256: "8ee8faf6865513ffa0051caf797f7e196ad82e6c9060e6e2ca9c0dace8e40536",
    purpose: "cast:lotta",
  },
  {
    path: "faces/cast/markku/1.jpg",
    sha256: "9d8fcc8c9163045c8775a98747136f9e65b1e4218b0e410ffac07c814537cc66",
    purpose: "cast:markku",
  },
  {
    path: "faces/cast/markku/2.jpg",
    sha256: "b2670bba63aefd9a496dff054b145dc25435966e014885c3df7a4c3438222db7",
    purpose: "cast:markku",
  },
  {
    path: "faces/cast/markku/3.jpg",
    sha256: "72a984440916816abd14b8281690709e499771a054d4eedb9ff10a29552002fb",
    purpose: "cast:markku",
  },
  {
    path: "faces/cast/mika/1.jpg",
    sha256: "deffe9b28f7b53133466c737c302edd77b473aeb6b8c8387162be379777d93e4",
    purpose: "cast:mika",
  },
  {
    path: "faces/cast/mika/2.jpg",
    sha256: "09eab7e2fc19c58aaff0747bf816b6c2a54fbf0918b838e05c8631688237d17d",
    purpose: "cast:mika",
  },
  {
    path: "faces/cast/mika/3.jpg",
    sha256: "532fe3f2a0af2bf1e6730de161b867f6967a9de7b011193cba0ea46b00577c95",
    purpose: "cast:mika",
  },
  {
    path: "faces/cast/minh/1.jpg",
    sha256: "24ee8adc45d254da2d57d081aa8c7716a83a471e6edd2e26bc20a9eed9fb963c",
    purpose: "cast:minh",
  },
  {
    path: "faces/cast/minh/2.jpg",
    sha256: "2b487487063e1d1c49ecac2773ec52308d6bc242c9672f466fc194e3ab8fe486",
    purpose: "cast:minh",
  },
  {
    path: "faces/cast/minh/3.jpg",
    sha256: "a84504680c3372844e41e834efc9ef1ca0ff63543610f54d03e7801f85925928",
    purpose: "cast:minh",
  },
  {
    path: "faces/cast/nea/1.jpg",
    sha256: "a1e2a7a6c6c594ac530764eacf13bd73036a0e4c3814b0dcbbeec893a21a4271",
    purpose: "cast:nea",
  },
  {
    path: "faces/cast/nea/2.jpg",
    sha256: "af07718e2f54af70e85ebeb96b183abd722b7d1b37940a2880e080b7413d9fae",
    purpose: "cast:nea",
  },
  {
    path: "faces/cast/nea/3.jpg",
    sha256: "4034266746976ea46cc5aebcb63c134acc8660d720a54167712e0ecb1d461280",
    purpose: "cast:nea",
  },
  {
    path: "faces/cast/niko/1.jpg",
    sha256: "a95bacb1b82a338cadc43468e2a28be28a6d1093f66c235b0a804bf0e2920139",
    purpose: "cast:niko",
  },
  {
    path: "faces/cast/niko/2.jpg",
    sha256: "abd2b8a42ca86d9e7e498e31e091868d60295195122ebaedb4439fc9633cf3c1",
    purpose: "cast:niko",
  },
  {
    path: "faces/cast/niko/3.jpg",
    sha256: "586d4c09b07c03c7257f9ab941f3fbc55f3f8a9a41f2d9872318258c75534d8e",
    purpose: "cast:niko",
  },
  {
    path: "faces/cast/olavi/1.jpg",
    sha256: "9b0f1b7e0d1a84dd17d54ab62f6256f1affac1ee776ccb44dbf9687d9aaca5d8",
    purpose: "cast:olavi",
  },
  {
    path: "faces/cast/olavi/2.jpg",
    sha256: "3b425c1a2f9cc4e39a3b6dc05488cb81a4ebcfbc199fa4a0e12f1ea7ec80224e",
    purpose: "cast:olavi",
  },
  {
    path: "faces/cast/olavi/3.jpg",
    sha256: "f2b50331d06aed0d64e9bc58900cc4094bb814c31df6f22ff2fccb5a07ca0733",
    purpose: "cast:olavi",
  },
  {
    path: "faces/cast/oskari/1.jpg",
    sha256: "8d8b45d5280247b64947c5008cf4a2d687a2f17b914bff03fd8db42680f90b31",
    purpose: "cast:oskari",
  },
  {
    path: "faces/cast/oskari/2.jpg",
    sha256: "d8896d02d40e3fce06df33f7a9d64c80e4b4f8f58419e59323e93e04f15b08e3",
    purpose: "cast:oskari",
  },
  {
    path: "faces/cast/oskari/3.jpg",
    sha256: "1ac8182e51d6c9a5e06e028fab28ef311f17bf0bb59939032a220ab3cfb6ef09",
    purpose: "cast:oskari",
  },
  {
    path: "faces/cast/paivi/1.jpg",
    sha256: "0f14e3fa292c54c243eeb7707d4978e6f4180095c0e8dde6d5e3bfa09f23eba9",
    purpose: "cast:paivi",
  },
  {
    path: "faces/cast/paivi/2.jpg",
    sha256: "cf47bbcdc4448e53c9bb00987b40601ccb098e9ed163cf65a47ed21957eac14d",
    purpose: "cast:paivi",
  },
  {
    path: "faces/cast/paivi/3.jpg",
    sha256: "a472b0370dbccfd5cc9b2fbf8d1447ce10f9fc5d996291087dd3483ccaa192ac",
    purpose: "cast:paivi",
  },
  {
    path: "faces/cast/pekka/1.jpg",
    sha256: "9660f5ce00607ade9b6dfc090c630db1791f5e3a25a451fe51cfad48258373a5",
    purpose: "cast:pekka",
  },
  {
    path: "faces/cast/pekka/2.jpg",
    sha256: "874f11959c083f37f5a95fc8e6798de31c800e53c1e4637f0a6b79ab2d6a8a05",
    purpose: "cast:pekka",
  },
  {
    path: "faces/cast/pekka/3.jpg",
    sha256: "b39ddd81c68fb913762287c5a89e78b99c8314e21877d68d0d84810af44f9c56",
    purpose: "cast:pekka",
  },
  {
    path: "faces/cast/petri/1.jpg",
    sha256: "38b8b0e23217ed9f007bfc1dd105226aee210e0e3a8ea87833132f606060d6e1",
    purpose: "cast:petri",
  },
  {
    path: "faces/cast/petri/2.jpg",
    sha256: "74b43e0cf4fe3b4a6696fcd372facf63fef7550e63263790017f3e6dfb1610c6",
    purpose: "cast:petri",
  },
  {
    path: "faces/cast/petri/3.jpg",
    sha256: "5ed5a80ec80664ec010f6fb81561549d5470b946b5bf96ebd010457f68857f85",
    purpose: "cast:petri",
  },
  {
    path: "faces/cast/pinja/1.jpg",
    sha256: "5201f2fe507da96e8ff08c94b2e88570838e4d55f0df93a0702f051619a19410",
    purpose: "cast:pinja",
  },
  {
    path: "faces/cast/pinja/2.jpg",
    sha256: "14177d6453960d7f0ee99a8a77c4f9c4d0568183a6eda3837ff77ed070770f42",
    purpose: "cast:pinja",
  },
  {
    path: "faces/cast/pinja/3.jpg",
    sha256: "2aebbab43f15de8ebd5400e9d67b06b3b2b1b43785871566239cb98ccabc1b85",
    purpose: "cast:pinja",
  },
  {
    path: "faces/cast/rasmus/1.jpg",
    sha256: "588d89ad12888e9101a6b8e68a01acbbaa18498ad2f5e4bd5a73a0972da312f8",
    purpose: "cast:rasmus",
  },
  {
    path: "faces/cast/rasmus/2.jpg",
    sha256: "6d6d642315ad75cb361ee025c4f456e546e053eaff0ce693c822cb234a269edf",
    purpose: "cast:rasmus",
  },
  {
    path: "faces/cast/rasmus/3.jpg",
    sha256: "cdaf4094923cf59c295c0ec2e8200b09a6821fdac83c967a9454f4aa00a2c610",
    purpose: "cast:rasmus",
  },
  {
    path: "faces/cast/risto/1.jpg",
    sha256: "5b5441fc9e2886c69a8b261c72aa1109392a6082de5fc188ffb6a447434420e4",
    purpose: "cast:risto",
  },
  {
    path: "faces/cast/risto/2.jpg",
    sha256: "197613658d624915007dcb7436dd2a512040fc2ab7a74fe12e0070cefa2ec27e",
    purpose: "cast:risto",
  },
  {
    path: "faces/cast/risto/3.jpg",
    sha256: "a32cc5d0317f911d49ade1a9927cb0e9385a66b8016f5a36ea0a5ac09efe9849",
    purpose: "cast:risto",
  },
  {
    path: "faces/cast/robin/1.jpg",
    sha256: "f426abd182736933b0249e8f3230b77505e4720df6ebc864192cc300a9bdc992",
    purpose: "cast:robin",
  },
  {
    path: "faces/cast/robin/2.jpg",
    sha256: "3cd3dcf85a108fd5de48264f6617cc30a211ae0d8f7e71638d0f6289e2fb6a90",
    purpose: "cast:robin",
  },
  {
    path: "faces/cast/robin/3.jpg",
    sha256: "a3e17176fde475d6e3ca6530b6401b680398b9c4a47b8ed5e0be080c3b52af41",
    purpose: "cast:robin",
  },
  {
    path: "faces/cast/ronja/1.jpg",
    sha256: "719044c72b52920dbb886b878c6ef1d02d16ab83a4bf11f375e53d790b9d44c3",
    purpose: "cast:ronja",
  },
  {
    path: "faces/cast/ronja/2.jpg",
    sha256: "73950b587c8c13b7f45a3b191840e003edf5f6b6074e91f5bcf64500fe681521",
    purpose: "cast:ronja",
  },
  {
    path: "faces/cast/ronja/3.jpg",
    sha256: "c593fbaa2e5cbeaf3bcfe9be40e8f77d55877bad0637529b43f49faa1da7ef1b",
    purpose: "cast:ronja",
  },
  {
    path: "faces/cast/saara/1.jpg",
    sha256: "01ffeedab659d07ae7db6a88ba7427ee8207797b497f441d5d6b438e82ae30e2",
    purpose: "cast:saara",
  },
  {
    path: "faces/cast/saara/2.jpg",
    sha256: "534dcf0a7320302ad58a97e0e8693db2dd043ac8c6f004878cf777f8872f1efb",
    purpose: "cast:saara",
  },
  {
    path: "faces/cast/saara/3.jpg",
    sha256: "03487a07a8f3a949c4e100d08523f064b2b5e932b989516611e2cc3140b50f84",
    purpose: "cast:saara",
  },
  {
    path: "faces/cast/samu/1.jpg",
    sha256: "c1c09f161f6bb7420f060994563c253bd7647c840d540a7fe3dc80343de1353a",
    purpose: "cast:samu",
  },
  {
    path: "faces/cast/samu/2.jpg",
    sha256: "16b98ccfe09b2262bd55051f7ba7dc6fb07dda2393cf0d6ca84f8a5fd02a546b",
    purpose: "cast:samu",
  },
  {
    path: "faces/cast/samu/3.jpg",
    sha256: "54d71d7a3e3ec31baf3088c12a843174463f024dcdc4896f8fbcb64835552854",
    purpose: "cast:samu",
  },
  {
    path: "faces/cast/sari/1.jpg",
    sha256: "601a8936e25d1fb7450d3ca7f09fb0cbd062a5e927d27f24f5484261c84f9a77",
    purpose: "cast:sari",
  },
  {
    path: "faces/cast/sari/2.jpg",
    sha256: "19318a3df7b97009b4c46fbf8fd8613a4506c157a0666c08b87ed64c73f8bcdd",
    purpose: "cast:sari",
  },
  {
    path: "faces/cast/sari/3.jpg",
    sha256: "7287f5f8c8cf50a4f045180e7a104cac2f2ea9f64e8ecdea803b6c9e771818bc",
    purpose: "cast:sari",
  },
  {
    path: "faces/cast/sasha/1.jpg",
    sha256: "53c4c21ffd49bc317e01f2900d943630136e8316b1cde7736b321cf3b525b78c",
    purpose: "cast:sasha",
  },
  {
    path: "faces/cast/sasha/2.jpg",
    sha256: "653c224449aada49ee623037ffbbb152a0b2d646e44fbb940f6a808c2ae0d879",
    purpose: "cast:sasha",
  },
  {
    path: "faces/cast/sasha/3.jpg",
    sha256: "250f1a76d55f5280f69d0ef7869a54f09be65bce18878706a88e9533004c9a13",
    purpose: "cast:sasha",
  },
  {
    path: "faces/cast/seppo/1.jpg",
    sha256: "e5303a990572bd3f17e5ea2e3ae1e5d4717e67e249109418aff9ce7c979b2e25",
    purpose: "cast:seppo",
  },
  {
    path: "faces/cast/seppo/2.jpg",
    sha256: "b78132bffdc24eec59537c76221c88ed77c744ed5ed7f5be942cbace70c310f1",
    purpose: "cast:seppo",
  },
  {
    path: "faces/cast/seppo/3.jpg",
    sha256: "860ee6dba4f50103891928f68d29b87c34ecf22eb2150a8dcf8981a034fae25e",
    purpose: "cast:seppo",
  },
  {
    path: "faces/cast/tiina/1.jpg",
    sha256: "9e4db908c14c700b12d3c4b3a601825589e2aaae8c23335a54beb4b60f7b7a60",
    purpose: "cast:tiina",
  },
  {
    path: "faces/cast/tiina/2.jpg",
    sha256: "c259f5a9e82a5b7836228b453e3716ff4dc8842935117d767463b06d8c9251c7",
    purpose: "cast:tiina",
  },
  {
    path: "faces/cast/tiina/3.jpg",
    sha256: "91043bd77b0253435a852f266ae6ef0c835114074921a41f61ecfb16e4d9efd1",
    purpose: "cast:tiina",
  },
  {
    path: "faces/cast/timo/1.jpg",
    sha256: "d69cb0989aa22398c86b428ebe1f31a143c86b23190e1416d8061252f460cb14",
    purpose: "cast:timo",
  },
  {
    path: "faces/cast/timo/2.jpg",
    sha256: "7e9004d37e9319b53863b98ba5619f4bfb7b7cda3d443b75d420dec106a724ae",
    purpose: "cast:timo",
  },
  {
    path: "faces/cast/timo/3.jpg",
    sha256: "a7d2a2b33e41a84d77a579628e0e5bdda7c5d8e2ffa6200d92cf0215fc8a3e2d",
    purpose: "cast:timo",
  },
  {
    path: "faces/cast/tuomas/1.jpg",
    sha256: "2102523a551cd35c0f03c1409c8a15e7814761e9d09f25d6cee704ab2837d784",
    purpose: "cast:tuomas",
  },
  {
    path: "faces/cast/tuomas/2.jpg",
    sha256: "46dfcc9af27c2cebda7b134182c191937a7490e0617dee2085de74a83340dca9",
    purpose: "cast:tuomas",
  },
  {
    path: "faces/cast/tuomas/3.jpg",
    sha256: "7d6bd2283b14b6c1dc057c797202f4e0fe5f836cfb238fc4f18519ee76e32981",
    purpose: "cast:tuomas",
  },
  {
    path: "faces/cast/yasmin/1.jpg",
    sha256: "dceceaf29f1abeb09e3c8ca6f11e0e1adcc86645d0610c11e887c1afa13edc4e",
    purpose: "cast:yasmin",
  },
  {
    path: "faces/cast/yasmin/2.jpg",
    sha256: "068d03d4f79e2b514b7b50e950bf949a8d7c405a967c0c9d3619df321bfdd1f9",
    purpose: "cast:yasmin",
  },
  {
    path: "faces/cast/yasmin/3.jpg",
    sha256: "60cda3185b72f79c0c231a3d84b90b752e1a5530d2288c048f8e5ce5c145549d",
    purpose: "cast:yasmin",
  },
  {
    path: "faces/cast/yusuf/1.jpg",
    sha256: "ad8f36ee1db89fe2044c591244111dd440b68dc82d3869ce09e683f27acb2a64",
    purpose: "cast:yusuf",
  },
  {
    path: "faces/cast/yusuf/2.jpg",
    sha256: "a10c39a3783da268988059c4b99e38f97faf0ea7b9ce708be03758b84d25500e",
    purpose: "cast:yusuf",
  },
  {
    path: "faces/cast/yusuf/3.jpg",
    sha256: "bfb3f6f423ee178d6d2415ae4b4a11c309f7ab4d4968d6c262356047cfa80591",
    purpose: "cast:yusuf",
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
