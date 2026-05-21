export type ParkSummary = {
  slug: string;
  name: string;
  shortName: string;
  summary: string;
};

export type ParkMetaResponse = {
  generatedAt: string;
  parks: ParkSummary[];
  defaultHiddenRideIds: string[];
  featureFlags: {
    recommendations: boolean;
    map: boolean;
    weather: boolean;
  };
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
  forecastWaitTime: number | null;
  forecastLowWaitTime: number | null;
  forecastHighWaitTime: number | null;
  forecastSampleSize: number;
  forecastTrendMinutes: number | null;
  dropMinutes: number | null;
  previousIsOpen: boolean | null;
  latitude: number | null;
  longitude: number | null;
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
  waitTime?: number | null;
  isOpen?: boolean | null;
};

export type RestaurantItem = {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
};

export type FacilityItem = {
  id: string;
  name: string;
  category: "restroom" | "water" | "first-aid";
  latitude: number | null;
  longitude: number | null;
};

export type CrowdPulse = {
  level: "lighter" | "typical" | "busier" | "building";
  headline: string;
  detail: string;
  averageWaitTime: number | null;
  deltaFromNormal: number | null;
  sampleSize: number;
  momentum: {
    direction: "easing" | "building" | "steady" | "learning";
    score: number;
    headline: string;
    detail: string;
    improvingCount: number;
    worseningCount: number;
    dropCount: number;
  };
};

export type RideHistoryPoint = {
  capturedAt: string;
  waitTime: number | null;
  isOpen: boolean;
};

export type RideHistoryBaselinePoint = {
  minuteOfDay: number;
  waitTime: number;
  sampleSize: number;
};

export type RideHistoryOperatingWindow = {
  openingTime: string;
  closingTime: string;
};

export type RideHistoryResponse = {
  rideId: string;
  points: RideHistoryPoint[];
  baselinePoints: RideHistoryBaselinePoint[];
  operatingWindow: RideHistoryOperatingWindow | null;
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
  crowdPulse: CrowdPulse;
  restaurants: RestaurantItem[];
  facilities: FacilityItem[];
  lands: LandGroup[];
};
