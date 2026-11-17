export interface Row {
  id: number;
  name: string;
  email: string;
  score: number;
}

export const rows: Row[] = Array.from({ length: 100 }, (_, i) => ({
  id: i + 1,
  name: `Person ${i + 1}`,
  email: `person${i + 1}@example.test`,
  score: (i * 7919) % 1000,
}));
