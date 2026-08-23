// Legacy flavor (SPEC §22): the family story, told in paper notes. Each
// moment fires once per run (sim/legacy.ts owns the once), pins its note to
// that evening's receipt, and settles into the Legacy album. The register:
// warm, concrete, a little dry at the end — never blocking, never a quest.
// Moments for future milestones (branches, the DC, transfers, AI) are
// written now and wired when their systems arrive.

export interface LegacyMomentDef {
  id: string;
  /** Album caption, set in Fraunces under the polaroid. */
  title: string;
  /** The note itself: 2–3 sentences in the §22 register. */
  text: string;
  /** The polaroid: a flat ground from the world palette + a big set mark. */
  photo: { ground: string; ink: string; mark: string };
}

const PAPER = "#fbf4e4";
const INK = "#20302b";

const LEGACY_MOMENTS: readonly LegacyMomentDef[] = [
  {
    id: "first_profit",
    title: "The first good day",
    text:
      "The drawer came out ahead tonight — truly ahead, after the rent and the lights. " +
      "Your grandfather used to press the first good receipt of the season flat under the till tray. " +
      "This one's yours.",
    photo: { ground: "#e7a03c", ink: INK, mark: "+$" },
  },
  {
    id: "first_hire",
    title: "A second set of keys",
    text:
      "For as long as anyone can remember, every bottle in this store passed through one pair of hands. " +
      "Tonight somebody else hung up an apron with their name on it. " +
      "Your grandmother would have fed them before letting them near a shelf.",
    photo: { ground: "#2f6b4f", ink: PAPER, mark: "TWO" },
  },
  {
    id: "first_renovation",
    title: "New walls, same counter",
    text:
      "The scaffolding went up this morning and the old shelves came down before lunch. " +
      "Your great-grandfather planed those boards himself — and he'd have been first up the ladder. " +
      "A store that stops changing is a store that's closing.",
    photo: { ground: "#3e8c84", ink: PAPER, mark: "GEN 2" },
  },
  {
    id: "license.L2",
    title: "Expanded Formulary",
    text:
      "A wider formulary means fewer neighbors sent across town with a slip and an apology. " +
      "Your father kept a list of every script he ever had to turn away. " +
      "Tonight it stops growing.",
    photo: { ground: "#6b4a32", ink: PAPER, mark: "L2" },
  },
  {
    id: "license.L3",
    title: "Controlled Substances",
    text:
      "There's a steel cabinet in the backroom now, and the state trusts you with what's inside. " +
      "Trust like that isn't bought with the filing fee. " +
      "It walked in with every honest fill before it.",
    photo: { ground: "#6b4a32", ink: PAPER, mark: "L3" },
  },
  {
    id: "license.L4",
    title: "Immunization Certification",
    text:
      "Flu season used to mean a bus ride to the clinic and a long afternoon. " +
      "Now it means a chair, a cold box, and thirty seconds of bravery. " +
      "Aunt Rosa says she'll go first if you count to three out loud.",
    photo: { ground: "#6b4a32", ink: PAPER, mark: "L4" },
  },
  {
    id: "license.L5",
    title: "Multi-Branch Operation",
    text:
      "One store was the whole family's dream, and now there's paperwork for a second. " +
      "Somewhere your great-grandfather is straightening his apron. " +
      "The name over the door is about to mean more than one door.",
    photo: { ground: "#6b4a32", ink: PAPER, mark: "L5" },
  },
  {
    id: "license.L6",
    title: "Distribution Operations",
    text:
      "Trucks, docks, manifests — words that never used to belong to a corner pharmacy. " +
      "The family name is going on the side of a van. " +
      "Your grandmother would have washed it twice a week.",
    photo: { ground: "#6b4a32", ink: PAPER, mark: "L6" },
  },
  {
    id: "first_gen4",
    title: "The Modern Clinic",
    text:
      "Mint, glass, and light oak — the store your great-grandfather raised is now the kind of place " +
      "he'd have pressed his nose against. Four generations of counters, and the same cross over the door. " +
      "He'd say it's too bright. He'd visit every day.",
    photo: { ground: "#bfe3d2", ink: INK, mark: "GEN 4" },
  },
  // --- Hooks: written now, fired by the milestones that build them ---
  {
    id: "first_branch",
    title: "The second door",
    text:
      "A new district, a new set of keys, the same name stenciled on the glass. " +
      "Opening day at the first store took three generations of saving. " +
      "This one took a Tuesday.",
    photo: { ground: "#8fae8b", ink: INK, mark: "No.2" },
  },
  {
    id: "dc_open",
    title: "The depot",
    text:
      "A whole building with no counter in it — just shelves, docks, and room to breathe. " +
      "The backroom used to be a closet with opinions. " +
      "Now it's an address.",
    photo: { ground: "#7d93a3", ink: PAPER, mark: "DC" },
  },
  {
    id: "first_transfer",
    title: "Family lines",
    text:
      "The first van run between your own stores went out this morning, stock moving on your say-so. " +
      "Your father drove emergency refills in a hatchback with a bad heater. " +
      "He'd have loved a van.",
    photo: { ground: "#b0663f", ink: PAPER, mark: "VAN" },
  },
  {
    id: "ai_modules",
    title: "The store that thinks",
    text:
      "The new module watches the queue, the shelf, and the weather, and sets tomorrow up before " +
      "you've locked tonight. Four generations of instinct, taught to a machine in an afternoon. " +
      "It still can't small-talk Mrs. Alvarez — you keep that part.",
    photo: { ground: "#20302b", ink: PAPER, mark: "AI" },
  },
];

const DEF_BY_ID = new Map(LEGACY_MOMENTS.map((def) => [def.id, def]));

export function legacyMomentDef(id: string): LegacyMomentDef {
  const def = DEF_BY_ID.get(id);
  if (!def) throw new Error(`Unknown legacy moment: ${id}`);
  return def;
}

export function isLegacyMoment(id: string): boolean {
  return DEF_BY_ID.has(id);
}
