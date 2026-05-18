export type ParkConfig = {
  slug: string;
  name: string;
  shortName: string;
  queueTimesParkId: number;
  themeparksEntityId: string;
  featuredShows: string[];
  latitude: number;
  longitude: number;
};

export const PARKS: ParkConfig[] = [
  {
    slug: "magic-kingdom",
    name: "Magic Kingdom Park",
    shortName: "Magic Kingdom",
    queueTimesParkId: 6,
    themeparksEntityId: "75ea578a-adc8-4116-a54d-dccb60765ef9",
    featuredShows: ["happily ever after", "disney starlight"],
    latitude: 28.4187,
    longitude: -81.5812
  },
  {
    slug: "epcot",
    name: "EPCOT",
    shortName: "EPCOT",
    queueTimesParkId: 5,
    themeparksEntityId: "47f90d2c-e191-4239-a466-5892ef59a88b",
    featuredShows: ["luminous", "fireworks"],
    latitude: 28.3747,
    longitude: -81.5494
  },
  {
    slug: "hollywood-studios",
    name: "Disney's Hollywood Studios",
    shortName: "Hollywood Studios",
    queueTimesParkId: 7,
    themeparksEntityId: "288747d1-8b4f-4a64-867e-ea7c9b27bad8",
    featuredShows: ["fantasmic"],
    latitude: 28.3575,
    longitude: -81.5580
  },
  {
    slug: "animal-kingdom",
    name: "Disney's Animal Kingdom Theme Park",
    shortName: "Animal Kingdom",
    queueTimesParkId: 8,
    themeparksEntityId: "1c84a229-8862-4648-9c71-378ddd2c7693",
    featuredShows: [],
    latitude: 28.3553,
    longitude: -81.5900
  }
];

export const PARK_BY_SLUG = Object.fromEntries(PARKS.map((park) => [park.slug, park]));

export const DB_PATH =
  process.env.DISNEY_WAIT_TIMES_DB_PATH ||
  `${process.cwd()}/python-service/data/disney_wait_times.db`;

export const QUEUE_TIMES_ATTRIBUTION = {
  label: "Powered by Queue-Times.com",
  href: "https://queue-times.com/"
};
