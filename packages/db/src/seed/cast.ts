import type { Gender, ProfileFields } from "@kuutti/schema";
import { POSTAL_CODE_LENGTH } from "@kuutti/schema/postal-areas";
import type { Queryable } from "../pool.ts";
import type { PersonaConversation } from "./conversations.ts";
import { assetsFor, type PhotoAsset } from "./photos.ts";
import { DEMO_EPOCH, DEMO_LABEL_PREFIX, type SyntheticPerson } from "./population.ts";
import type { WaitingLikes } from "./rounds.ts";
import { DEMO_SUBJECT_PREFIX } from "./write-population.ts";

/**
 * The cast (#560): forty-eight invented people nobody signs in as, so that the
 * accounts a staging phone can sign in as have somebody to go through. They have
 * no code and no test bank, so they are synthetic people of the population
 * (ADR-014 §9), written with it and removed with it, and each has a set of faces
 * of their own in the release (`cast:<key>`, docs/demo/photo-prompts.md).
 *
 * A card never shows whom its person seeks or their age window, so these are wide:
 * one man fits Sanna, Kerttu and Noa alike. What sets the number is Sanna, who
 * seeks only men. Nobody here fits Iida's window, so the round's flow keeps its
 * exact queue. A test holds all of it against the product's own filters
 * (apps/api/scripts/demo/demo-cast.test.ts).
 */
type CastAnswers = {
  seeks: readonly Gender[];
  ageWindow: { min: number; max: number };
  intent: NonNullable<ProfileFields["intent"]>;
};

const EVERYBODY: readonly Gender[] = ["woman", "man", "non_binary"];
/** Sanna, Kerttu and Noa, whatever each of them has answered. */
const MEN_FOR_MEMBERS: CastAnswers = {
  seeks: ["woman", "non_binary"],
  ageWindow: { min: 30, max: 62 },
  intent: "long_term",
};
/** Kerttu and Noa, and too old for Iida's window and too narrow for her age. */
const WOMEN_FOR_MEMBERS: CastAnswers = {
  seeks: ["woman", "non_binary"],
  ageWindow: { min: 40, max: 60 },
  intent: "long_term",
};
const NON_BINARY_PEOPLE: CastAnswers = {
  seeks: EVERYBODY,
  ageWindow: { min: 25, max: 55 },
  intent: "open_to_either",
};
/** Aino and Onni after their onboarding, whichever of the answers they give. */
const YOUNGER_PEOPLE: CastAnswers = {
  seeks: EVERYBODY,
  ageWindow: { min: 21, max: 45 },
  intent: "open_to_either",
};

export type CastPerson = {
  /** The folder of the faces (`faces/cast/<key>/`) and the end of the label. Never renamed and never reused. */
  key: string;
  name: string;
  born: { year: number; month: number };
  gender: Gender;
  answers: CastAnswers;
  /** The postal code as a person would type it: what is kept of it is the API's to say. */
  home: string;
  /** The card shows the area's name, where the area is kept. */
  showsArea?: true;
  locale: "fi" | "sv" | "en";
  title: string;
  hobbies: NonNullable<ProfileFields["hobbies"]>;
  pets: NonNullable<ProfileFields["pets"]>;
  bio: string;
};

export const CAST: readonly CastPerson[] = [
  // Men for the members.
  {
    key: "jere",
    name: "Jere",
    born: { year: 1982, month: 1 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "02600",
    showsArea: true,
    locale: "en",
    title: "Wedding DJ",
    hobbies: ["making_music", "concerts", "karaoke"],
    pets: ["cat"],
    bio: "I play weddings on Saturdays and teach physics on weekdays. Both crowds ignore me until the end, and then they want one more.",
  },
  {
    key: "pekka",
    name: "Pekka",
    born: { year: 1974, month: 8 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "33500",
    locale: "fi",
    title: "Bussinkuljettaja",
    hobbies: ["fishing", "sauna", "cottage"],
    pets: ["none"],
    bio: "Ajan bussia Tampereella ja talvella istun jäällä. Suurin saaliini on ollut pieni, mutta tarinani siitä kasvaa vuosi vuodelta.",
  },
  {
    key: "markku",
    name: "Markku",
    born: { year: 1977, month: 4 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "04200",
    locale: "en",
    title: "Accountant",
    hobbies: ["horses", "running", "puzzles"],
    pets: ["none"],
    bio: "Accountant by trade. I took up hobbyhorsing as a joke and then won a rosette, so now it is serious. My spreadsheets are very tidy.",
  },
  {
    key: "risto",
    name: "Risto",
    born: { year: 1979, month: 11 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "02180",
    locale: "en",
    title: "Piano tuner",
    hobbies: ["dogs", "concerts", "slow_mornings"],
    pets: ["dog"],
    bio: "I tune pianos and walk a greyhound who has better posture than I do. Looking for someone who likes slow mornings and the odd concert.",
  },
  {
    key: "antero",
    name: "Antero",
    born: { year: 1976, month: 7 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "08100",
    locale: "en",
    title: "Beekeeper",
    hobbies: ["gardening", "baking", "cottage"],
    pets: ["other"],
    bio: "Beekeeper with sticky hands and an orchard that gets out of control every June. I will bring honey whether you like it or not.",
  },
  {
    key: "mika",
    name: "Mika",
    born: { year: 1980, month: 3 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "01600",
    locale: "en",
    title: "Firefighter",
    hobbies: ["floorball", "cooking", "gym"],
    pets: ["cat"],
    bio: "Firefighter. I mostly cook soup for hungry colleagues and get cats out of trees. The cats are never grateful, and I have made my peace with that.",
  },
  {
    key: "olavi",
    name: "Olavi",
    born: { year: 1973, month: 10 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "96100",
    locale: "fi",
    title: "Huskytarhan pitäjä",
    hobbies: ["skiing", "dogs", "winter_swimming"],
    pets: ["dog"],
    bio: "Pidän huskytarhaa Rovaniemellä. Koirat kuuntelevat minua paremmin kuin kukaan ihminen, ja aamut alkavat aikaisin.",
  },
  {
    key: "juha",
    name: "Juha",
    born: { year: 1985, month: 6 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "02150",
    showsArea: true,
    locale: "en",
    title: "Software developer",
    hobbies: ["baking", "cycling", "programming"],
    pets: ["none"],
    bio: "Software developer and failed baker. My sourdough could hold a door open, and I keep trying anyway. You are welcome to taste the next attempt.",
  },
  {
    key: "karim",
    name: "Karim",
    born: { year: 1981, month: 2 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "01300",
    locale: "en",
    title: "Dentist",
    hobbies: ["karaoke", "travelling", "coffee"],
    pets: ["none"],
    bio: "Dentist who sings karaoke badly and with great feeling. I will not judge your flossing on a first date, but I will notice.",
  },
  {
    key: "timo",
    name: "Timo",
    born: { year: 1978, month: 9 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "04400",
    locale: "en",
    title: "Motorcycle mechanic",
    hobbies: ["road_trips", "diy", "dogs"],
    pets: ["dog"],
    bio: "I fix old motorcycles and my dachshund supervises from the sidecar. Road trips, coffee from a thermos, and no hurry to get anywhere.",
  },
  {
    key: "harri",
    name: "Harri",
    born: { year: 1983, month: 5 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "80100",
    locale: "en",
    title: "Librarian",
    hobbies: ["crafts", "reading", "concerts"],
    pets: ["dog"],
    bio: "Librarian and heavy metal knitter, and yes, those go together. My pug has more jumpers than I do. Tell me what you are reading.",
  },
  {
    key: "esa",
    name: "Esa",
    born: { year: 1975, month: 1 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "70100",
    locale: "fi",
    title: "Postimies",
    hobbies: ["gardening", "cycling", "sauna"],
    pets: ["none"],
    bio: "Postimies Kuopiosta. Kesällä kasvatan kurpitsoja palstalla ja talvella pyöräilen lumisateessa. Kerron mielelläni kurpitsoista lisää.",
  },
  {
    key: "dmitri",
    name: "Dmitri",
    born: { year: 1984, month: 8 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "00700",
    locale: "en",
    title: "Truck driver",
    hobbies: ["dance", "cooking", "chess"],
    pets: ["none"],
    bio: "I drive trucks all week and dance ballroom at the weekend, sometimes with a mop when nobody is free. I cook better than I park.",
  },
  {
    key: "seppo",
    name: "Seppo",
    born: { year: 1976, month: 4 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "10600",
    locale: "sv",
    title: "Smed",
    hobbies: ["crafts", "sauna", "cooking"],
    pets: ["cat"],
    bio: "Jag är smed i Ekenäs, med stora händer och en liten grå kattunge. Bastu på lördagar, soppa på söndagar och inga onödiga ord.",
  },
  {
    key: "anders",
    name: "Anders",
    born: { year: 1980, month: 11 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "02700",
    locale: "sv",
    title: "Maskinist",
    hobbies: ["sailing", "swimming", "dogs"],
    pets: ["dog"],
    bio: "Maskinist på skärgårdsfärjan. Min newfoundlandshund tar hela båten och jag sitter där det finns plats. Jag kokar bra kaffe på vilken kobbe som helst.",
  },
  {
    key: "tuomas",
    name: "Tuomas",
    born: { year: 1982, month: 7 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "99130",
    locale: "en",
    title: "Geography teacher",
    hobbies: ["astronomy", "skiing", "photography"],
    pets: ["none"],
    bio: "Geography teacher in Lapland. I will wake you at two in the morning if the aurora is out, and I am not sorry about it.",
  },
  {
    key: "minh",
    name: "Minh",
    born: { year: 1983, month: 3 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "00980",
    locale: "en",
    title: "Structural engineer",
    hobbies: ["foraging", "karaoke", "cooking"],
    pets: ["other"],
    bio: "Structural engineer who picks mushrooms and sings karaoke. My parrot repeats everything I say on video calls, so please be kind to me in advance.",
  },
  {
    key: "petri",
    name: "Petri",
    born: { year: 1979, month: 10 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "90100",
    locale: "en",
    title: "Nurse",
    hobbies: ["cycling", "football", "slow_mornings"],
    pets: ["other"],
    bio: "Nurse who cycles all year, whatever Oulu throws at me. At home a very large rabbit eats my newspaper. I am told this is not normal.",
  },
  {
    key: "janne",
    name: "Janne",
    born: { year: 1985, month: 6 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "00510",
    locale: "en",
    title: "Insurance adjuster",
    hobbies: ["concerts", "pub_quiz", "road_trips"],
    pets: ["none"],
    bio: "Insurance adjuster by day, air guitarist by night. I have seen every kind of flooded basement and I own a cape. Pub quiz partner wanted.",
  },
  {
    key: "ari",
    name: "Ari",
    born: { year: 1978, month: 2 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "48100",
    locale: "en",
    title: "Tugboat engineer",
    hobbies: ["electronics", "diy", "sailing"],
    pets: ["cat"],
    bio: "Tugboat engineer from Kotka. I build model ships at home and my cat takes them apart again. A seagull once stole my lunch, and I still think about it.",
  },
  {
    key: "lasse",
    name: "Lasse",
    born: { year: 1974, month: 9 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "87100",
    locale: "fi",
    title: "Metsänhoitaja",
    hobbies: ["hiking", "birdwatching", "foraging"],
    pets: ["dog"],
    bio: "Metsänhoitaja Kajaanista. Karjalankarhukoira kulkee mukana ja kahvi keitetään nuotiolla. Hirvi on yleensä huomannut minut ennen kuin minä sen.",
  },
  {
    key: "kalle",
    name: "Kalle",
    born: { year: 1986, month: 5 },
    gender: "man",
    answers: MEN_FOR_MEMBERS,
    home: "02770",
    locale: "en",
    title: "Carpenter",
    hobbies: ["diy", "winter_swimming", "dogs"],
    pets: ["dog"],
    bio: "Carpenter. I built my dog a better house than my own, and we have both been stuck in it. Winter swimming keeps me humble.",
  },
  // Women for the members.
  {
    key: "tiina",
    name: "Tiina",
    born: { year: 1976, month: 1 },
    gender: "woman",
    answers: WOMEN_FOR_MEMBERS,
    home: "00100",
    locale: "en",
    title: "School principal",
    hobbies: ["dance", "theatre", "travelling"],
    pets: ["other"],
    bio: "School principal on weekdays, roller derby on Tuesdays. I am looking for somebody who laughs loudly and does not mind a goat eating their scarf.",
  },
  {
    key: "paivi",
    name: "Päivi",
    born: { year: 1979, month: 8 },
    gender: "woman",
    answers: WOMEN_FOR_MEMBERS,
    home: "60100",
    locale: "fi",
    title: "Eläinlääkäri",
    hobbies: ["horses", "cats", "dance"],
    pets: ["cat"],
    bio: "Eläinlääkäri maatiloilla. Lehmät nuolevat tukkani pystyyn ja kotona hoidan kissanpentuja. Tanssin tangoa, myös ilman paria.",
  },
  {
    key: "sari",
    name: "Sari",
    born: { year: 1974, month: 4 },
    gender: "woman",
    answers: WOMEN_FOR_MEMBERS,
    home: "11100",
    locale: "fi",
    title: "Rekkakuski",
    hobbies: ["road_trips", "sauna", "dogs"],
    pets: ["dog"],
    bio: "Ajan rekkaa pitkin Suomea ja chihuahua istuu kojelaudalla. Sauna, keilaus ja hyvä nauru riittävät minulle.",
  },
  {
    key: "leena",
    name: "Leena",
    born: { year: 1981, month: 11 },
    gender: "woman",
    answers: WOMEN_FOR_MEMBERS,
    home: "20100",
    locale: "en",
    title: "Greenhouse gardener",
    hobbies: ["gardening", "cycling", "cooking"],
    pets: ["other"],
    bio: "Greenhouse gardener in Turku. My hens have opinions, and one of them sits on my head. I will try to give you a plant, so be warned.",
  },
  // Non-binary people.
  {
    key: "sasha",
    name: "Sasha",
    born: { year: 1992, month: 7 },
    gender: "non_binary",
    answers: NON_BINARY_PEOPLE,
    home: "33100",
    locale: "en",
    title: "Tattoo artist",
    hobbies: ["drawing", "photography", "video_games"],
    pets: ["other"],
    bio: "Tattoo artist who draws geometry all day and skates badly on the lake when it freezes. Two ferrets live in my hoodie.",
  },
  {
    key: "robin",
    name: "Robin",
    born: { year: 1988, month: 3 },
    gender: "non_binary",
    answers: NON_BINARY_PEOPLE,
    home: "00500",
    showsArea: true,
    locale: "en",
    title: "Costume maker",
    hobbies: ["theatre", "crafts", "forest_walks"],
    pets: ["dog"],
    bio: "I make costumes for a theatre and sometimes forget to take the ruff off before lunch. My old beagle disapproves of rain, and of me.",
  },
  // Younger men.
  {
    key: "eemil",
    name: "Eemil",
    born: { year: 1998, month: 10 },
    gender: "man",
    answers: YOUNGER_PEOPLE,
    home: "00530",
    showsArea: true,
    locale: "en",
    title: "Barista",
    hobbies: ["coffee", "cinema", "running"],
    pets: ["cat"],
    bio: "Barista who can tell what kind of day you are having from your order. My cat sits on my head during video calls. I run when I have to.",
  },
  {
    key: "abdi",
    name: "Abdi",
    born: { year: 1996, month: 6 },
    gender: "man",
    answers: YOUNGER_PEOPLE,
    home: "00930",
    locale: "en",
    title: "Software tester",
    hobbies: ["football", "baking", "video_games"],
    pets: ["dog"],
    bio: "Software tester and football coach, which means I find mistakes all week. My corgi gets carried home when it rains. I bake, with mixed results.",
  },
  {
    key: "aleksi",
    name: "Aleksi",
    born: { year: 1997, month: 2 },
    gender: "man",
    answers: YOUNGER_PEOPLE,
    home: "15110",
    locale: "en",
    title: "Tree surgeon",
    hobbies: ["climbing", "forest_walks", "board_games"],
    pets: ["none"],
    bio: "Tree surgeon. I spend my days up in the birches, where the squirrels treat me as furniture. Board games when my feet are back on the ground.",
  },
  {
    key: "niko",
    name: "Niko",
    born: { year: 1995, month: 9 },
    gender: "man",
    answers: YOUNGER_PEOPLE,
    home: "02230",
    locale: "en",
    title: "Physiotherapist",
    hobbies: ["padel", "dogs", "travelling"],
    pets: ["dog"],
    bio: "Physiotherapist who has moved house too many times. My poodle and I share a hairdresser, more or less. Padel partner wanted, and help with a wardrobe.",
  },
  {
    key: "samu",
    name: "Samu",
    born: { year: 1998, month: 5 },
    gender: "man",
    answers: YOUNGER_PEOPLE,
    home: "33500",
    locale: "en",
    title: "Plumber",
    hobbies: ["skiing", "video_games", "cottage"],
    pets: ["none"],
    bio: "Plumber and snowboarder. If your sink is leaking, I am the one grinning under it. In summer you will find me on the lake in any weather.",
  },
  {
    key: "rasmus",
    name: "Rasmus",
    born: { year: 1996, month: 1 },
    gender: "man",
    answers: YOUNGER_PEOPLE,
    home: "00180",
    showsArea: true,
    locale: "en",
    title: "Ferry deckhand",
    hobbies: ["making_music", "sailing", "dogs"],
    pets: ["dog"],
    bio: "Deckhand on the ferries and accordion player on the side. My dog shakes mud on everybody equally. I like long evenings and quiet squares.",
  },
  {
    key: "joonas",
    name: "Joonas",
    born: { year: 1997, month: 8 },
    gender: "man",
    answers: YOUNGER_PEOPLE,
    home: "20500",
    locale: "en",
    title: "Game developer",
    hobbies: ["video_games", "board_games", "cinema"],
    pets: ["cat"],
    bio: "Game developer. I make my own costumes and the rain ruins them. A black cat sleeps on my keyboard, so replies may take a while.",
  },
  {
    key: "elias",
    name: "Elias",
    born: { year: 1995, month: 4 },
    gender: "man",
    answers: YOUNGER_PEOPLE,
    home: "60100",
    locale: "fi",
    title: "Viljelijä",
    hobbies: ["cottage", "ice_hockey", "diy"],
    pets: ["other"],
    bio: "Viljelijä Seinäjoelta. Vasikat pitävät minusta enemmän kuin kukko, ja kukko on tehnyt sen selväksi. Kesällä heinää, talvella lätkää.",
  },
  {
    key: "yusuf",
    name: "Yusuf",
    born: { year: 1997, month: 11 },
    gender: "man",
    answers: YOUNGER_PEOPLE,
    home: "01300",
    locale: "en",
    title: "City planner",
    hobbies: ["hiking", "photography", "cooking"],
    pets: ["none"],
    bio: "City planner who grows tomatoes on the roof and gets lost on purpose in Lapland. I can read any plan except the one for a wardrobe.",
  },
  {
    key: "oskari",
    name: "Oskari",
    born: { year: 1996, month: 7 },
    gender: "man",
    answers: YOUNGER_PEOPLE,
    home: "40100",
    locale: "fi",
    title: "Sähköasentaja",
    hobbies: ["ice_hockey", "cats", "electronics"],
    pets: ["cat"],
    bio: "Sähköasentaja Jyväskylästä ja harrastajamaalivahti. Yksi etuhammas meni pelissä, ja kolme kissaa pitävät minut nöyränä.",
  },
  // Younger women.
  {
    key: "saara",
    name: "Saara",
    born: { year: 2002, month: 3 },
    gender: "woman",
    answers: YOUNGER_PEOPLE,
    home: "80100",
    locale: "fi",
    title: "Metsätalouden opiskelija",
    hobbies: ["hiking", "foraging", "dogs"],
    pets: ["dog"],
    bio: "Opiskelen metsätaloutta Joensuussa ja halaan puita työkseni, mittanauhan kanssa. Olen hukannut saappaan suohon, enkä kadu mitään.",
  },
  {
    key: "fanni",
    name: "Fanni",
    born: { year: 2001, month: 10 },
    gender: "woman",
    answers: YOUNGER_PEOPLE,
    home: "00560",
    locale: "en",
    title: "Baker",
    hobbies: ["baking", "dance", "concerts"],
    pets: ["none"],
    bio: "Baker, up at five. I make very good cinnamon buns and one memorable wedding cake. Dancing and concerts when I can keep my eyes open.",
  },
  {
    key: "lotta",
    name: "Lotta",
    born: { year: 2000, month: 6 },
    gender: "woman",
    answers: YOUNGER_PEOPLE,
    home: "10600",
    locale: "sv",
    title: "Veterinärstudent",
    hobbies: ["horses", "sailing", "swimming"],
    pets: ["other"],
    bio: "Veterinärstudent och ryttare från Ekenäs. Min häst stjäl mina smörgåsar och jag sitter ofta i en vattenpöl. Jag trivs bäst vid havet.",
  },
  {
    key: "aada",
    name: "Aada",
    born: { year: 1999, month: 2 },
    gender: "woman",
    answers: YOUNGER_PEOPLE,
    home: "28100",
    locale: "en",
    title: "Geologist",
    hobbies: ["hiking", "concerts", "pub_quiz"],
    pets: ["none"],
    bio: "Geologist. Yes, I lick rocks, and I can explain why. I have also lost a tent at a festival, so I make no promises about camping.",
  },
  {
    key: "nea",
    name: "Nea",
    born: { year: 1998, month: 9 },
    gender: "woman",
    answers: YOUNGER_PEOPLE,
    home: "02650",
    locale: "en",
    title: "Emergency nurse",
    hobbies: ["dogs", "running", "podcasts"],
    pets: ["dog"],
    bio: "Emergency nurse with two old rescue dogs who own the bed. I listen to podcasts on long runs and eat ice cream in any weather.",
  },
  {
    key: "yasmin",
    name: "Yasmin",
    born: { year: 1997, month: 5 },
    gender: "woman",
    answers: YOUNGER_PEOPLE,
    home: "00510",
    showsArea: true,
    locale: "en",
    title: "Trainee lawyer",
    hobbies: ["martial_arts", "reading", "cats"],
    pets: ["cat"],
    bio: "Trainee lawyer and boxer. I win most arguments and lose to most yoghurt lids. My cat has no hair and a very warm jumper.",
  },
  {
    key: "emilia",
    name: "Emilia",
    born: { year: 1996, month: 1 },
    gender: "woman",
    answers: YOUNGER_PEOPLE,
    home: "04200",
    locale: "en",
    title: "Cartographer",
    hobbies: ["running", "puzzles", "dogs"],
    pets: ["dog"],
    bio: "Cartographer and orienteer, which does not stop me from getting lost. My terrier hides in the laundry. I will always know roughly where north is.",
  },
  {
    key: "alina",
    name: "Alina",
    born: { year: 1996, month: 8 },
    gender: "woman",
    answers: YOUNGER_PEOPLE,
    home: "53100",
    locale: "en",
    title: "Physiotherapist",
    hobbies: ["dance", "yoga", "learning_languages"],
    pets: ["other"],
    bio: "Physiotherapist and former ballet dancer. I still practise on piers when nobody is looking. My tortoise and I are both in no hurry.",
  },
  {
    key: "pinja",
    name: "Pinja",
    born: { year: 1995, month: 4 },
    gender: "woman",
    answers: YOUNGER_PEOPLE,
    home: "67100",
    locale: "fi",
    title: "Jäähallin hoitaja",
    hobbies: ["ice_hockey", "sauna", "cottage"],
    pets: ["dog"],
    bio: "Hoidan jäähallia Kokkolassa ja jackrussell ajaa jäänhoitokonetta kanssani. Kesät vietän mökillä. Sauna lämpiää aina.",
  },
  {
    key: "ronja",
    name: "Ronja",
    born: { year: 1998, month: 11 },
    gender: "woman",
    answers: YOUNGER_PEOPLE,
    home: "57100",
    locale: "en",
    title: "Chimney sweep",
    hobbies: ["climbing", "coffee", "dogs"],
    pets: ["dog"],
    bio: "Chimney sweep, which is lucky for you. I like rooftops at sunrise and very clean cafés, where I am not always welcome. My schnauzer dislikes rain.",
  },
];

/** What the languages field says, by the language the profile is written in. */
const LANGUAGES: Record<CastPerson["locale"], NonNullable<ProfileFields["languages"]>> = {
  fi: ["fi", "en"],
  sv: ["sv", "fi"],
  en: ["en", "fi"],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export const castLabel = (key: string): string => `${DEMO_LABEL_PREFIX}cast-${key}`;

/**
 * The cast as people of the population. `keep` is the API's rule for what is
 * kept of a postal code (ADR-061 §2), handed in as the places are; somebody with
 * no home would be in nobody's pool with nothing to say so, so that is refused.
 */
export function castPeople(keep: (postalCode: string) => string | null): SyntheticPerson[] {
  return CAST.map((person, i) => {
    const place = keep(person.home);
    if (place === null) throw new Error(`${person.key}: nothing is kept of ${person.home}`);
    const registeredAt = new Date(DEMO_EPOCH.getTime() - (i + 1) * DAY_MS);
    const givenAt = new Date(registeredAt.getTime() + 3 * MINUTE_MS);
    return {
      label: castLabel(person.key),
      state: "active",
      birthYear: person.born.year,
      birthMonth: person.born.month,
      registeredAt,
      pond: "suomi",
      home: {
        place,
        showsArea: person.showsArea === true && place.length === POSTAL_CODE_LENGTH,
      },
      gender: person.gender,
      preferences: { seeks: [...person.answers.seeks], ageWindow: { ...person.answers.ageWindow } },
      consents: (["terms", "privacy", "special_category"] as const).map((kind) => ({
        kind,
        localeShown: person.locale,
        givenAt,
      })),
      profile: {
        displayName: person.name,
        bio: person.bio,
        bioPreset: null,
        fields: {
          intent: person.answers.intent,
          languages: LANGUAGES[person.locale],
          hobbies: person.hobbies,
          pets: person.pets,
          occupationTitle: person.title,
        },
        prompts: [],
        specialCategoryConsentedAt: null,
      },
    };
  });
}

/** Each person's own faces by label: never another's, so that a card shows one person. */
export function castFaces(manifest: readonly PhotoAsset[]): Map<string, PhotoAsset[]> {
  return new Map(
    CAST.map((person) => [castLabel(person.key), assetsFor(manifest, `cast:${person.key}`)]),
  );
}

/** The accounts of the cast by key, of those who have been written. */
export async function castAccounts(db: Queryable): Promise<Map<string, string>> {
  const keys = new Map(
    CAST.map((person) => [`${DEMO_SUBJECT_PREFIX}${castLabel(person.key)}`, person.key]),
  );
  const { rows } = await db.query<{ subject: string; id: string }>(
    `SELECT i.broker_subject AS subject, a.id
       FROM identity i JOIN account a ON a.identity_id = i.id
      WHERE i.broker_subject = ANY($1)`,
    [[...keys.keys()]],
  );
  const accounts = new Map<string, string>();
  for (const { subject, id } of rows) {
    const key = keys.get(subject);
    if (key) accounts.set(key, id);
  }
  return accounts;
}

/**
 * Takes away the chats a member's erasure left with the cast: erasure keeps a
 * conversation for the other side (TD-1), and nobody signs in as these people, so
 * nobody would ever read it, and every reset would leave more. How many went.
 */
export async function removeCastLeftovers(
  db: Queryable,
  accounts: ReadonlyMap<string, string>,
): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM conversation WHERE id IN (
       SELECT mine.conversation_id
         FROM conversation_participant mine
         JOIN conversation_participant gone
           ON gone.conversation_id = mine.conversation_id AND gone.account_id IS NULL
        WHERE mine.account_id = ANY($1))`,
    [[...accounts.values()]],
  );
  return rowCount ?? 0;
}

/**
 * What waits when a member opens People, the day after it was given: a fish comes
 * first in the queue, so Jere, the DJ, is the first card on all three accounts,
 * and a like back makes a match (ADR-062 §2).
 */
export const CAST_LIKES: readonly WaitingLikes[] = [
  { of: "sanna", fishFrom: ["jere"], likedBy: ["risto", "karim"] },
  { of: "noa", fishFrom: ["jere"], likedBy: ["robin", "timo"] },
  { of: "kerttu", fishFrom: ["jere"], likedBy: ["tiina"] },
];

/**
 * The members' chats, in the language each of them writes (histories.ts): one on
 * the member's turn, with something unread, and, where there are two, one on the
 * other's. Written as the stories' conversations are; a chat partner is no card
 * while the conversation stands (ADR-062 §6).
 */
export const CAST_CONVERSATIONS: readonly PersonaConversation[] = [
  {
    between: ["sanna", "juha"],
    openedHoursAgo: 52,
    messages: [
      {
        from: "b",
        hoursAgo: 50,
        body: "Hei Sanna! Arkkitehti ja lintuharrastaja. Voiko talon piirtää niin, että tikka viihtyy?",
      },
      {
        from: "a",
        hoursAgo: 47,
        body: "Voi, mutta naapurit eivät silloin viihdy. Mitä sinä leivot? Profiilissasi puhuttiin ovesta.",
      },
      {
        from: "b",
        hoursAgo: 30,
        body: "Hapanjuurileipää. Se pitää nyt ovea auki, ja ovi on tyytyväinen.",
      },
    ],
    readUpTo: { a: 2, b: 2 },
  },
  {
    between: ["sanna", "mika"],
    openedHoursAgo: 40,
    messages: [
      {
        from: "a",
        hoursAgo: 38,
        body: "Moi Mika! Onko paloaseman keittiössä oikeasti aina keittoa?",
      },
      {
        from: "b",
        hoursAgo: 36,
        body: "Aina. Se on ainoa asia, joka ei koskaan pala pohjaan. Melkein.",
      },
      { from: "a", hoursAgo: 20, body: "Kuulostaa turvalliselta. Millainen keitto on paras?" },
    ],
    readUpTo: { a: 3, b: 2 },
  },
  {
    between: ["noa", "harri"],
    openedHoursAgo: 60,
    messages: [
      {
        from: "b",
        hoursAgo: 58,
        body: "Hi Noa. You said to tell you what I am reading, so: a very long book about moss. Your turn.",
      },
      {
        from: "a",
        hoursAgo: 55,
        body: "Moss is underrated. I am reading about trees. How is the knitting going?",
      },
      {
        from: "b",
        hoursAgo: 28,
        body: "Slowly. The sock has become a small scarf. Can you really name a tree by its bark?",
      },
    ],
    readUpTo: { a: 2, b: 2 },
  },
  {
    between: ["noa", "leena"],
    openedHoursAgo: 34,
    messages: [
      { from: "a", hoursAgo: 32, body: "Hello Leena. I have to ask about the hen on your head." },
      {
        from: "b",
        hoursAgo: 30,
        body: "Her name is Sirpa and she does what she wants. Do you climb anything without a rope?",
      },
      {
        from: "a",
        hoursAgo: 18,
        body: "Only bouldering walls, and only badly. Does Sirpa come along on dates?",
      },
    ],
    readUpTo: { a: 3, b: 2 },
  },
  {
    between: ["kerttu", "seppo"],
    openedHoursAgo: 44,
    messages: [
      {
        from: "b",
        hoursAgo: 42,
        body: "Hej Kerttu! Havet, en bra bok och nybryggt kaffe låter som en bra dag. Vilken bok just nu?",
      },
      {
        from: "a",
        hoursAgo: 39,
        body: "En deckare som jag redan har gissat slutet på. Vad gör en smed när det regnar?",
      },
      {
        from: "b",
        hoursAgo: 24,
        body: "Samma sak som annars, men med dörren stängd. Kattungen sover i förklädet.",
      },
    ],
    readUpTo: { a: 2, b: 2 },
  },
];
