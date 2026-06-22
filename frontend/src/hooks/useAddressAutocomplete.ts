import { useEffect, useRef, useState } from "preact/hooks";

export interface AddressResult {
  street: string;
  city: string;
  state: string;
  zip: string;
  lat: number | null;
  lon: number | null;
}

export interface Suggestion {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
}

export interface UseAddressAutocompleteReturn {
  inputValue: string;
  setInputValue: (v: string) => void;
  suggestions: Suggestion[];
  showDropdown: boolean;
  activeSuggestionIndex: number;
  selectSuggestion: (s: Suggestion) => Promise<void>;
  isLoading: boolean;
  handleInput: (e: Event) => void;
  handleKeyDown: (e: KeyboardEvent) => void;
  handleFocus: () => void;
  handleBlur: () => void;
  mapsReady: boolean;
}

let _mapsApiKey: string | null | undefined = undefined;
let _mapsLoadPromise: Promise<void> | null = null;
let _autocompleteService: any = null;
let _placesService: any = null;
let _placesDiv: HTMLDivElement | null = null;

const STATE_MAP: Record<string, string> = {
  AR: "Arkansas", AL: "Alabama", AK: "Alaska", AZ: "Arizona",
  CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

async function fetchMapsKey(): Promise<string | null> {
  if (_mapsApiKey !== undefined) return _mapsApiKey;
  try {
    const res = await fetch("/api/config/maps");
    const data = (await res.json()) as { key: string | null; configured: boolean };
    _mapsApiKey = data.configured ? data.key : null;
    return _mapsApiKey;
  } catch {
    _mapsApiKey = null;
    return null;
  }
}

function placesLibraryReady(): boolean {
  const g = (window as any).google?.maps?.places;
  return !!(g?.AutocompleteService && g?.AutocompleteSessionToken);
}

function loadMapsScript(apiKey: string): Promise<void> {
  if (_mapsLoadPromise) return _mapsLoadPromise;
  _mapsLoadPromise = new Promise((resolve, reject) => {
    if (placesLibraryReady()) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google Maps failed to load"));
    document.head.appendChild(script);
  });
  return _mapsLoadPromise;
}

function getAutocompleteService(): any {
  const g = (window as any).google?.maps?.places;
  if (!_autocompleteService && g?.AutocompleteService) {
    _autocompleteService = new g.AutocompleteService();
  }
  return _autocompleteService;
}

function getPlacesService(): any {
  const g = (window as any).google?.maps?.places;
  if (!_placesService && g?.PlacesService) {
    if (!_placesDiv) {
      _placesDiv = document.createElement("div");
      document.body.appendChild(_placesDiv);
    }
    _placesService = new g.PlacesService(_placesDiv);
  }
  return _placesService;
}

function getPredictions(query: string, token: any): Promise<Suggestion[]> {
  return new Promise((resolve) => {
    const svc = getAutocompleteService();
    if (!svc) {
      resolve([]);
      return;
    }
    svc.getPlacePredictions(
      {
        input: query,
        types: ["address"],
        componentRestrictions: { country: "us" },
        sessionToken: token,
      },
      (predictions: any[] | null, status: string) => {
        if (status !== "OK" || !predictions) {
          resolve([]);
          return;
        }
        resolve(
          predictions.map((p) => ({
            placeId: p.place_id,
            description: p.description,
            mainText: p.structured_formatting?.main_text ?? p.description,
            secondaryText: p.structured_formatting?.secondary_text ?? "",
          })),
        );
      },
    );
  });
}

function getPlaceDetails(placeId: string, token: any): Promise<AddressResult | null> {
  return new Promise((resolve) => {
    const svc = getPlacesService();
    if (!svc) {
      resolve(null);
      return;
    }
    svc.getDetails(
      { placeId, fields: ["address_components", "geometry"], sessionToken: token },
      (place: any, status: string) => {
        if (status !== "OK" || !place) {
          resolve(null);
          return;
        }
        const comps = place.address_components ?? [];
        const get = (type: string, short = false): string => {
          const c = comps.find((x) => x.types?.includes(type));
          return c ? (short ? c.short_name : c.long_name) : "";
        };
        const street = [get("street_number"), get("route")].filter(Boolean).join(" ");
        const city = get("locality") || get("sublocality_level_1") || get("neighborhood");
        const stateShort = get("administrative_area_level_1", true);
        const stateLong = get("administrative_area_level_1");
        const state = STATE_MAP[stateShort] ?? stateLong ?? stateShort;
        const zip = get("postal_code");
        const lat = place.geometry?.location?.lat() ?? null;
        const lon = place.geometry?.location?.lng() ?? null;
        resolve({ street, city, state, zip, lat, lon });
      },
    );
  });
}

export function useAddressAutocomplete(
  onSelect: (result: AddressResult) => void,
  initialValue = "",
  onInputChange?: (value: string) => void,
): UseAddressAutocompleteReturn {
  const [inputValue, setInputValue] = useState(initialValue);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [mapsReady, setMapsReady] = useState(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionToken = useRef<any>(null);

  function getOrCreateSessionToken(): any {
    const g = (window as any).google?.maps?.places;
    if (!g?.AutocompleteSessionToken) return null;
    if (!sessionToken.current) {
      sessionToken.current = new g.AutocompleteSessionToken();
    }
    return sessionToken.current;
  }

  function clearSessionToken(): void {
    sessionToken.current = null;
  }

  function cancelBlurClear(): void {
    if (blurClearTimer.current) {
      clearTimeout(blurClearTimer.current);
      blurClearTimer.current = null;
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const key = await fetchMapsKey();
      if (!key || cancelled) return;
      try {
        await loadMapsScript(key);
        if (!cancelled && placesLibraryReady()) setMapsReady(true);
      } catch {
        /* degrade gracefully */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectSuggestion = async (suggestion: Suggestion) => {
    cancelBlurClear();
    const token = sessionToken.current ?? getOrCreateSessionToken();
    setInputValue(suggestion.mainText);
    setShowDropdown(false);
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
    setIsLoading(true);
    const result = await getPlaceDetails(suggestion.placeId, token);
    clearSessionToken();
    setIsLoading(false);
    if (result) {
      setInputValue(result.street);
      onSelect(result);
    }
  };

  const handleInput = (e: Event) => {
    const target = e.currentTarget as HTMLInputElement | null;
    const value = target?.value ?? (e.target as HTMLInputElement)?.value ?? "";
    setInputValue(value);
    onInputChange?.(value);
    setActiveSuggestionIndex(-1);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (!value.trim() || !mapsReady || value.length < 3) {
      setSuggestions([]);
      setShowDropdown(false);
      if (!value.trim()) clearSessionToken();
      return;
    }
    cancelBlurClear();
    getOrCreateSessionToken();
    debounceTimer.current = setTimeout(async () => {
      setIsLoading(true);
      const results = await getPredictions(value, sessionToken.current);
      setIsLoading(false);
      setSuggestions(results);
      setShowDropdown(results.length > 0);
    }, 300);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!showDropdown) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveSuggestionIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSuggestionIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && activeSuggestionIndex >= 0) {
      e.preventDefault();
      void selectSuggestion(suggestions[activeSuggestionIndex]);
    } else if (e.key === "Escape") {
      setShowDropdown(false);
      setActiveSuggestionIndex(-1);
    }
  };

  const handleFocus = () => {
    cancelBlurClear();
    if (suggestions.length > 0) setShowDropdown(true);
  };
  const handleBlur = () => {
    // Defer clearing so mousedown on a suggestion runs selectSuggestion first.
    cancelBlurClear();
    blurClearTimer.current = setTimeout(() => {
      blurClearTimer.current = null;
      clearSessionToken();
    }, 200);
    setTimeout(() => setShowDropdown(false), 150);
  };

  return {
    inputValue,
    setInputValue,
    suggestions,
    showDropdown,
    activeSuggestionIndex,
    selectSuggestion,
    isLoading,
    handleInput,
    handleKeyDown,
    handleFocus,
    handleBlur,
    mapsReady,
  };
}
