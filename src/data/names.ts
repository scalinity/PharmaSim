// Fictional customer name pools (milestone 03). Names show up on Rx cards
// from milestone 04; customers carry one from day one.

export const FIRST_NAMES: readonly string[] = [
  "Ada", "Alma", "Amos", "Beatrix", "Bennett", "Birdie", "Cass", "Clara",
  "Cyrus", "Delia", "Dorian", "Edith", "Elias", "Esme", "Ezra", "Flora",
  "Gideon", "Greta", "Harlan", "Hazel", "Ida", "Ines", "Jasper", "June",
  "Kit", "Lena", "Leopold", "Mabel", "Milo", "Nella", "Nico", "Odette",
  "Oren", "Pearl", "Quincy", "Rosa", "Rufus", "Sadie", "Silas", "Thea",
  "Ulysses", "Vera", "Walt", "Wilhelmina", "Xenia", "York", "Zelda", "Zeno",
];

export const LAST_NAMES: readonly string[] = [
  "Abernathy", "Ashdown", "Barlowe", "Bramble", "Cardwell", "Cobble", "Danvers", "Dovetail",
  "Eastgate", "Elderberry", "Fairweather", "Fenwick", "Gable", "Greenlaw", "Hargrove", "Hollis",
  "Ivory", "Juniper", "Kestrel", "Lakeshore", "Larkspur", "Mercer", "Mossgrove", "Nightingale",
  "Oakhurst", "Pemberton", "Quill", "Rainier", "Rowanwood", "Saffron", "Silverman", "Thistle",
  "Umberly", "Vale", "Wexford", "Whitlock", "Yarrow", "Zephyrine",
];

export function randomFullName(): string {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)]!;
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)]!;
  return `${first} ${last}`;
}
