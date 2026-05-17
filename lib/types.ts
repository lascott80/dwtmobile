export type ParkSummary = {
  slug: string;
  name: string;
  shortName: string;
  summary: string;
};

export type ParkMetaResponse = {
  generatedAt: string;
  parks: ParkSummary[];
};

export type ParkHoursEntry = {
  type: string;
  description: string | null;
  openingTime: string;
  closingTime: string;
};

export type RideItem = {
  id: string;
  name: string;
  status: string;
  waitTime: number | null;
  isOpen: boolean;
  lastUpdated: string | null;
  trendMinutes: number | null;
  normalWaitTime: number | null;
  previousIsOpen: boolean | null;
};

export type LandGroup = {
  name: string;
  rides: RideItem[];
};

export type ShowTimeItem = {
  id: string;
  name: string;
  startTime: string;
  endTime: string | null;
  status: string;
};

export type ParkDetailResponse = {
  park: ParkSummary;
  status: {
    hasData: boolean;
    stale: boolean;
    lastSuccessAt: string | null;
    lastError: string | null;
  };
  hours: ParkHoursEntry[];
  featuredShows: ShowTimeItem[];
  meetGreets: ShowTimeItem[];
  lands: LandGroup[];
};
