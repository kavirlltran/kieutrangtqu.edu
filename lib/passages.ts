export type Passage = { id: string; title: string; text: string };

export const DEFAULT_PASSAGES: Passage[] = [
  {
    id: "p1",
    title: "Short passage 1",
    text: "Some parents admire famous athletes as strong role models, so they name their children after them.",
  },
  {
    id: "p2",
    title: "Short passage 2",
    text: "Travel today is vastly different from what it used to be. People can fly across the world in a single day and stay connected with family and friends through their phones.",
  },
  {
    id: "p3",
    title: "IELTS-style 1",
    text: "In many cities, public transportation is becoming more important as traffic gets worse. Buses and trains can reduce pollution and help people save time, but they must be reliable and affordable to be truly effective.",
  },
];

export const USER_PASSAGES_STORAGE_KEY = "custom_passages_v1";
