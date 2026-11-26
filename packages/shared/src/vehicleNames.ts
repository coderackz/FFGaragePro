// Vehicle makes and models: the built-in list (common in the UAE), short names, and the rules that correct what an
// advisor types — automatically, like a phone keyboard, never asking. A name that isn't listed is kept as typed.

/** How names are compared: no capitals, spaces or punctuation ("Land Cruiser" = "LANDCRUISER" = "land-cruiser"). */
export const nameKey = (s: string | null | undefined): string => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

interface MakeEntry {
  name: string;
  models: string[];
  /** Other names for its models: short names, codes, local names → the model. */
  modelAliases?: Record<string, string>;
}

/** Makes and their models, as garages in the UAE meet them. Not every model: anything else is kept as typed. */
export const VEHICLE_MAKES: MakeEntry[] = [
  {
    name: "Toyota",
    models: ["Land Cruiser", "Land Cruiser Prado", "Land Cruiser 70", "Hilux", "Fortuner", "Corolla", "Corolla Cross", "Camry", "Yaris", "RAV4", "Rush", "Innova", "Hiace",
      "Coaster", "Avalon", "Sequoia", "Tundra", "4Runner", "FJ Cruiser", "Highlander", "C-HR", "Granvia", "Veloz", "Raize", "bZ4X", "Supra", "Crown", "Prius", "Urban Cruiser", "Previa"],
    modelAliases: { LC200: "Land Cruiser", LC300: "Land Cruiser", LC100: "Land Cruiser", Prado: "Land Cruiser Prado", LC70: "Land Cruiser 70", LC76: "Land Cruiser 70", LC79: "Land Cruiser 70", FJ: "FJ Cruiser" },
  },
  {
    name: "Nissan",
    models: ["Patrol", "Patrol Safari", "Patrol Pickup", "X-Trail", "Pathfinder", "Altima", "Sunny", "Sentra", "Maxima", "Kicks", "Navara", "Urvan", "Juke", "Qashqai", "Armada",
      "Micra", "Tiida", "Xterra", "GT-R", "Z", "Magnite", "Civilian"],
    modelAliases: { Y61: "Patrol", Y62: "Patrol", Safari: "Patrol Safari" },
  },
  { name: "Lexus", models: ["LX", "GX", "RX", "ES", "IS", "LS", "NX", "UX", "RC", "LC", "LM", "TX"], modelAliases: { LX570: "LX", LX600: "LX", GX460: "GX", RX350: "RX", ES350: "ES", ES250: "ES", LS500: "LS" } },
  { name: "Mitsubishi", models: ["Pajero", "Pajero Sport", "Montero Sport", "Outlander", "ASX", "Attrage", "Mirage", "L200", "Xpander", "Eclipse Cross", "Lancer", "Destinator"] },
  { name: "Mitsubishi Fuso", models: ["Canter", "Fighter", "Rosa"] },
  { name: "Honda", models: ["Accord", "Civic", "City", "CR-V", "HR-V", "Pilot", "Odyssey", "Jazz", "ZR-V"], modelAliases: { Fit: "Jazz" } },
  {
    name: "Hyundai",
    models: ["Accent", "Elantra", "Sonata", "Tucson", "Santa Fe", "Creta", "Kona", "Palisade", "Azera", "Venue", "Staria", "H-1", "Grand i10", "i10", "i20", "Ioniq 5", "Ioniq 6", "Grandeur"],
  },
  { name: "Kia", models: ["Picanto", "Pegas", "Rio", "Cerato", "K5", "Optima", "Sportage", "Sorento", "Seltos", "Carnival", "Telluride", "Soluto", "Sonet", "K8", "EV6", "EV9", "Mohave"] },
  { name: "Mazda", models: ["Mazda2", "Mazda3", "Mazda6", "CX-3", "CX-30", "CX-5", "CX-60", "CX-9", "CX-90", "BT-50", "MX-5"] },
  { name: "Suzuki", models: ["Swift", "Dzire", "Ciaz", "Baleno", "Vitara", "Grand Vitara", "Jimny", "Ertiga", "Celerio", "Alto", "APV", "Fronx", "S-Presso", "Super Carry"] },
  { name: "Isuzu", models: ["D-Max", "MU-X", "NPR", "NQR", "NKR", "ELF", "FVR"] },
  { name: "Infiniti", models: ["QX50", "QX55", "QX60", "QX70", "QX80", "Q50", "Q60"] },
  { name: "Genesis", models: ["G70", "G80", "G90", "GV70", "GV80"] },
  { name: "Subaru", models: ["Forester", "Outback", "XV", "Crosstrek", "Impreza", "WRX", "BRZ"] },
  {
    name: "Ford",
    models: ["F-150", "Ranger", "Explorer", "Expedition", "Edge", "Mustang", "Bronco", "Territory", "Taurus", "Transit", "Escape", "Everest", "Focus", "Figo", "Raptor"],
    modelAliases: { F150: "F-150" },
  },
  {
    name: "Chevrolet",
    models: ["Tahoe", "Suburban", "Silverado", "Captiva", "Malibu", "Camaro", "Corvette", "Traverse", "Spark", "Aveo", "Cruze", "Trailblazer", "Groove", "Blazer", "Equinox", "Colorado", "Express"],
  },
  { name: "GMC", models: ["Yukon", "Yukon XL", "Sierra", "Acadia", "Terrain", "Savana", "Canyon", "Hummer EV"] },
  { name: "Cadillac", models: ["Escalade", "CT4", "CT5", "XT4", "XT5", "XT6", "Lyriq"] },
  { name: "Dodge", models: ["Charger", "Challenger", "Durango"] },
  { name: "RAM", models: ["1500", "2500", "3500"] },
  { name: "Jeep", models: ["Wrangler", "Grand Cherokee", "Cherokee", "Compass", "Renegade", "Gladiator", "Wagoneer", "Grand Wagoneer"] },
  { name: "Chrysler", models: ["300", "300C", "Pacifica"] },
  { name: "Lincoln", models: ["Navigator", "Aviator", "Nautilus", "Corsair"] },
  {
    name: "Mercedes-Benz",
    models: ["A-Class", "C-Class", "E-Class", "S-Class", "CLA", "CLS", "GLA", "GLB", "GLC", "GLE", "GLS", "G-Class", "Sprinter", "Vito", "V-Class", "AMG GT", "EQE", "EQS", "Maybach"],
    modelAliases: { C200: "C-Class", C300: "C-Class", E200: "E-Class", E300: "E-Class", S500: "S-Class", S580: "S-Class", G63: "G-Class", G500: "G-Class", "G Wagon": "G-Class" },
  },
  { name: "BMW", models: ["1 Series", "2 Series", "3 Series", "4 Series", "5 Series", "7 Series", "8 Series", "X1", "X2", "X3", "X4", "X5", "X6", "X7", "XM", "Z4", "M3", "M4", "M5", "i4", "i7", "iX"] },
  { name: "Audi", models: ["A3", "A4", "A5", "A6", "A7", "A8", "Q2", "Q3", "Q5", "Q7", "Q8", "e-tron", "R8", "RS6", "RS Q8"] },
  { name: "Volkswagen", models: ["Golf", "Polo", "Jetta", "Passat", "Tiguan", "Touareg", "Teramont", "Atlas", "T-Roc", "ID.4", "Transporter"] },
  { name: "Porsche", models: ["Cayenne", "Macan", "Panamera", "911", "Taycan", "Cayman", "Boxster"] },
  {
    name: "Land Rover",
    models: ["Range Rover", "Range Rover Sport", "Range Rover Velar", "Range Rover Evoque", "Defender", "Discovery", "Discovery Sport"],
    modelAliases: { RRS: "Range Rover Sport", Velar: "Range Rover Velar", Evoque: "Range Rover Evoque" },
  },
  { name: "Jaguar", models: ["F-Pace", "E-Pace", "I-Pace", "XF", "XE", "XJ", "F-Type"] },
  { name: "Volvo", models: ["XC40", "XC60", "XC90", "S60", "S90", "EX30"] },
  { name: "Mini", models: ["Cooper", "Countryman", "Clubman"] },
  { name: "Peugeot", models: ["208", "2008", "3008", "5008", "508", "301", "Partner", "Expert", "Boxer", "Landtrek"] },
  { name: "Renault", models: ["Duster", "Koleos", "Megane", "Symbol", "Dokker", "Captur", "Talisman"] },
  { name: "Fiat", models: ["500", "Tipo", "Doblo", "Ducato"] },
  { name: "MG", models: ["MG3", "MG4", "MG5", "MG6", "MG7", "ZS", "HS", "RX5", "RX8", "GT", "One", "Whale"] },
  { name: "Chery", models: ["Tiggo 2", "Tiggo 4 Pro", "Tiggo 7 Pro", "Tiggo 8 Pro", "Arrizo 5", "Arrizo 6", "Arrizo 8"] },
  { name: "Geely", models: ["Coolray", "Emgrand", "Tugella", "Monjaro", "Okavango", "Azkarra", "Geometry C", "Atlas", "Starray"] },
  { name: "Changan", models: ["Alsvin", "CS35", "CS35 Plus", "CS75", "CS85", "CS95", "Eado", "UNI-K", "UNI-T", "UNI-V", "Hunter"] },
  { name: "Haval", models: ["H6", "Jolion", "H9", "Dargo"] },
  { name: "Great Wall", models: ["Wingle", "Poer"] },
  { name: "Tank", models: ["300", "500"] },
  { name: "Jetour", models: ["X70", "X70 Plus", "X90", "Dashing", "T1", "T2"] },
  { name: "Exeed", models: ["TXL", "VX", "LX", "RX"] },
  { name: "GAC", models: ["GS3", "GS4", "GS8", "GA4", "GA6", "GA8", "Emkoo", "Empow"] },
  { name: "Hongqi", models: ["H5", "HS5", "E-HS9", "H9", "HS7"] },
  { name: "Kaiyi", models: ["X3", "X3 Pro", "E5"] },
  { name: "JAC", models: ["J7", "JS4", "S3", "S4", "T8"] },
  { name: "BYD", models: ["Atto 3", "Seal", "Han", "Tang", "Song Plus", "Dolphin", "Qin Plus", "Shark"] },
  { name: "Tesla", models: ["Model 3", "Model Y", "Model S", "Model X", "Cybertruck"] },
  { name: "Bentley", models: ["Bentayga", "Continental GT", "Flying Spur"] },
  { name: "Rolls-Royce", models: ["Cullinan", "Ghost", "Phantom", "Wraith", "Dawn", "Spectre"] },
  { name: "Lamborghini", models: ["Urus", "Huracan", "Aventador", "Revuelto"] },
  { name: "Ferrari", models: ["Roma", "296", "SF90", "Purosangue", "F8", "812"] },
  { name: "Maserati", models: ["Levante", "Ghibli", "Grecale", "Quattroporte", "MC20"] },
  { name: "Aston Martin", models: ["DBX", "DB11", "DB12", "Vantage"] },
  { name: "Hino", models: ["300", "500"] },
  { name: "Tata", models: [] },
  { name: "Ashok Leyland", models: [] },
  { name: "Foton", models: [] },
];

/** Other names for makes → the make. */
export const MAKE_ALIASES: Record<string, string> = {
  merc: "Mercedes-Benz", mercedes: "Mercedes-Benz", benz: "Mercedes-Benz", mb: "Mercedes-Benz",
  vw: "Volkswagen", chevy: "Chevrolet", gwm: "Great Wall", fuso: "Mitsubishi Fuso", rangerover: "Land Rover", landrover: "Land Rover",
  rr: "Rolls-Royce", lambo: "Lamborghini", bimmer: "BMW",
};

/** A name the screen replaces what was typed with; `note`: say so ("Corrected from …"), else it's only the list's spelling. */
export interface Correction { value: string; note: boolean }

/** Edits between two keys (insert, delete, change, swap two letters next to each other). */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * What a typed name should read, among `names` (the list's first, so its spelling wins): the same name spelt the
 * list's way (silently); another name for one (`aliases`, with a note); or the one name within a letter (up to five
 * letters) or two (longer) — never when two are as close, or the typed name is under three letters.
 */
function correct(typed: string, names: string[], aliases: Record<string, string>): Correction | null {
  const k = nameKey(typed);
  if (!k) return null;
  const byKey = new Map<string, string>();
  for (const n of names) if (!byKey.has(nameKey(n))) byKey.set(nameKey(n), n);
  const same = byKey.get(k);
  if (same !== undefined) return same === typed.trim() ? null : { value: same, note: false };
  const alias = aliases[k];
  if (alias) return { value: alias, note: true };
  if (k.length < 3) return null;
  const limit = k.length <= 5 ? 1 : 2;
  let best: string | null = null, bestD = Infinity, tie = false;
  for (const [key, name] of byKey) {
    const d = distance(k, key);
    if (d < bestD) { best = name; bestD = d; tie = false; } else if (d === bestD) tie = true;
  }
  return best !== null && bestD <= limit && !tie ? { value: best, note: true } : null;
}

const makeEntry = (make: string | null | undefined) => {
  const k = nameKey(make);
  return VEHICLE_MAKES.find((m) => nameKey(m.name) === k) ?? (MAKE_ALIASES[k] ? VEHICLE_MAKES.find((m) => m.name === MAKE_ALIASES[k]) : undefined);
};
const keyed = (aliases: Record<string, string> = {}) => Object.fromEntries(Object.entries(aliases).map(([a, v]) => [nameKey(a), v]));

/** The make as it should read: among the list's makes and the garage's own (`garageMakes`, already used on its vehicles). */
export function correctMake(typed: string, garageMakes: string[]): Correction | null {
  return correct(typed, [...VEHICLE_MAKES.map((m) => m.name), ...garageMakes], MAKE_ALIASES);
}

/** The model as it should read: only among `make`'s models (the list's and the garage's own); nothing without a make. */
export function correctModel(typed: string, make: string, garageModels: { make: string; name: string }[]): Correction | null {
  if (!nameKey(make)) return null;
  const entry = makeEntry(make);
  const own = garageModels.filter((m) => nameKey(m.make) === nameKey(make) || (entry && nameKey(m.make) === nameKey(entry.name))).map((m) => m.name);
  return correct(typed, [...(entry?.models ?? []), ...own], keyed(entry?.modelAliases));
}

/** The make a model belongs to, when only one listed make has it (or calls something by that name). */
export function makeOfModel(model: string): string | null {
  const k = nameKey(model);
  if (!k) return null;
  const makes = VEHICLE_MAKES.filter((m) => m.models.some((x) => nameKey(x) === k) || keyed(m.modelAliases)[k]);
  return makes.length === 1 ? makes[0]!.name : null;
}

/** The list's models of a make (for suggestions). */
export const modelsOf = (make: string): string[] => makeEntry(make)?.models ?? [];
/** The list's makes (for suggestions). */
export const MAKE_NAMES = VEHICLE_MAKES.map((m) => m.name);

/** Manufacturer codes (the VIN's first characters) → make; the longest code that matches wins. */
const VIN_MAKERS: Record<string, string> = {
  JTH: "Lexus", JTJ: "Lexus", JT: "Toyota", MR0: "Toyota", MHF: "Toyota",
  JNK: "Infiniti", JNR: "Infiniti", JN: "Nissan", MNT: "Nissan",
  JHM: "Honda", JHL: "Honda", JM1: "Mazda", JM3: "Mazda", JMZ: "Mazda", JA3: "Mitsubishi", JA4: "Mitsubishi", JMB: "Mitsubishi",
  JAA: "Isuzu", JAL: "Isuzu", MPA: "Isuzu", JS2: "Suzuki", JS3: "Suzuki", MA3: "Suzuki", JF1: "Subaru", JF2: "Subaru",
  KMH: "Hyundai", KM8: "Hyundai", KNA: "Kia", KNB: "Kia", KNC: "Kia", KND: "Kia", KNE: "Kia", KMT: "Genesis",
  WDB: "Mercedes-Benz", WDD: "Mercedes-Benz", WDC: "Mercedes-Benz", WDF: "Mercedes-Benz", W1K: "Mercedes-Benz", W1N: "Mercedes-Benz", W1V: "Mercedes-Benz",
  WBA: "BMW", WBS: "BMW", WBX: "BMW", WBY: "BMW", WAU: "Audi", WUA: "Audi", WA1: "Audi", WVW: "Volkswagen", WVG: "Volkswagen", WV1: "Volkswagen", WV2: "Volkswagen",
  WP0: "Porsche", WP1: "Porsche", SAL: "Land Rover", SAJ: "Jaguar", SCB: "Bentley", SCA: "Rolls-Royce",
  ZFA: "Fiat", ZFF: "Ferrari", ZHW: "Lamborghini", ZAM: "Maserati", YV1: "Volvo", YV4: "Volvo", VF1: "Renault", VF3: "Peugeot",
  "1FA": "Ford", "1FT": "Ford", "1FM": "Ford", "1FD": "Ford", "2FM": "Ford", "3FA": "Ford", MNB: "Ford", "1LN": "Lincoln", "5LM": "Lincoln",
  "1G1": "Chevrolet", "1GC": "Chevrolet", "1GN": "Chevrolet", "1GT": "GMC", "1GK": "GMC", "1GY": "Cadillac", "1J4": "Jeep", "1J8": "Jeep", "1C6": "RAM",
  "5YJ": "Tesla", "7SA": "Tesla", LRW: "Tesla", LVV: "Chery", L6T: "Geely", LGW: "Great Wall", LS5: "Changan", LGX: "BYD", LMG: "GAC",
};

/** The make a VIN's manufacturer code says, when it's one we know. */
export function makeFromVin(vin: string): string | null {
  const v = vin.trim().toUpperCase();
  if (v.length < 11) return null;
  return VIN_MAKERS[v.slice(0, 3)] ?? VIN_MAKERS[v.slice(0, 2)] ?? null;
}
