// Top-bar search: Movie · Zip · Date · Find Showtimes, other fields in an Options popover. Pure form, no fetching.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BookingRequest, SearchRequest } from "../../../shared/types";
import { clock, localDate } from "../format";

export type SeatPref = BookingRequest["seat_pref"];

export type SearchFormProps = {
  initial?: Partial<SearchRequest> & { seat_pref?: SeatPref };
  busy: boolean;
  /** A booking is in progress: searching is disabled until it ends or is cancelled. */
  locked?: boolean;
  onSubmit: (req: SearchRequest, seatPref: SeatPref) => void;
};

const NYC_ZIP = /^(10[0-4]|11[0-4]|116)\d{2}$/;
const FORMATS: NonNullable<SearchRequest["format"]>[] = ["any", "imax", "dolby", "standard"];
const FORMAT_LABEL = (f: string) => (f === "any" ? "Any" : f === "imax" ? "IMAX" : f[0].toUpperCase() + f.slice(1));
const SEAT_LABEL: Record<SeatPref, string> = { center: "Center", aisle: "Aisle", any: "Any", pick: "I'll pick" };
/** "18:00" → "6:00 PM" via the shared clock() (which reads HH:MM at offset 11). */
const hhmm = (t: string) => clock(`0000-00-00T${t}`);

export function SearchForm({ initial, busy, locked = false, onSubmit }: SearchFormProps) {
  const today = localDate();
  const maxDate = localDate(14);
  const [movie, setMovie] = useState(initial?.movie ?? "");
  const [zip, setZip] = useState(initial?.zip ?? "");
  const [date, setDate] = useState(initial?.date && initial.date >= today ? initial.date : today);
  const [party, setParty] = useState(initial?.party_size ?? 2);
  const [seatPref, setSeatPref] = useState<SeatPref>(initial?.seat_pref ?? "center");
  const [timeFrom, setTimeFrom] = useState(initial?.time_from ?? "");
  const [timeTo, setTimeTo] = useState(initial?.time_to ?? "");
  const [format, setFormat] = useState<NonNullable<SearchRequest["format"]>>(initial?.format ?? "any");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);

  const errors = {
    movie: movie.trim() ? "" : "Enter a movie",
    zip: !/^\d{5}$/.test(zip) ? "Enter a 5-digit zip" : !NYC_ZIP.test(zip) ? "NYC zips only" : "",
    date: date < today || date > maxDate ? "Pick a date in the next 2 weeks" : "",
    time: timeFrom && timeTo && timeFrom > timeTo ? "“From” must be before “To”" : "",
  };
  const valid = !Object.values(errors).some(Boolean);

  // Close the Options popover on outside click or Escape.
  useEffect(() => {
    if (!optionsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!optionsRef.current?.contains(e.target as Node)) setOptionsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOptionsOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [optionsOpen]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy || locked) return;
    setOptionsOpen(false);
    onSubmit({
      movie: movie.trim(), zip, date, party_size: party, format,
      ...(timeFrom ? { time_from: timeFrom } : {}),
      ...(timeTo ? { time_to: timeTo } : {}),
    }, seatPref);
  };

  const summary = [
    `${party} adult${party > 1 ? "s" : ""}`,
    SEAT_LABEL[seatPref],
    format !== "any" ? FORMAT_LABEL(format) : "",
    timeFrom || timeTo ? `${timeFrom ? hhmm(timeFrom) : "…"}–${timeTo ? hhmm(timeTo) : "…"}` : "",
  ].filter(Boolean).join(" · ");

  return (
    <form className="search-bar" onSubmit={submit} noValidate>
      <label className="tfield tfield--movie">
        <span>Enter Movie</span>
        <input value={movie} onChange={(e) => setMovie(e.target.value)} placeholder="e.g. Street Fighter" autoFocus />
        {movie && errors.movie && <em className="tfield__error">{errors.movie}</em>}
      </label>
      <label className="tfield tfield--zip">
        <span>Zip Code</span>
        <input value={zip} inputMode="numeric" maxLength={5} placeholder="10018"
          onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))} />
        {zip && errors.zip && <em className="tfield__error">{errors.zip}</em>}
      </label>
      <label className="tfield tfield--date">
        <span>Select Date</span>
        <input type="date" value={date} min={today} max={maxDate} onChange={(e) => setDate(e.target.value)} />
        {errors.date && <em className="tfield__error">{errors.date}</em>}
      </label>

      <div className="search-bar__go">
        <button className="btn search-bar__submit" type="submit" disabled={!valid || busy || locked}>
          {busy ? "Searching…" : "Find Showtimes"}
        </button>
        {locked && <em className="search-bar__note">Finish or cancel the booking first</em>}
      </div>

      <div className="options" ref={optionsRef}>
        <button type="button" className={`options__toggle${errors.time ? " options__toggle--error" : ""}`}
          aria-expanded={optionsOpen} onClick={() => setOptionsOpen((o) => !o)}>
          <span className="options__label">Options</span>
          <span className="options__summary">{errors.time ? "Fix the time window" : summary}</span>
        </button>
        {optionsOpen && (
          <div className="options__pop" role="group" aria-label="Search options">
            <label className="field">
              <span>Tickets</span>
              <select value={party} onChange={(e) => setParty(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} adult{n > 1 ? "s" : ""}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Seats</span>
              <select value={seatPref} onChange={(e) => setSeatPref(e.target.value as SeatPref)}>
                <option value="center">Center</option>
                <option value="aisle">Aisle</option>
                <option value="any">Any</option>
                <option value="pick">I'll pick</option>
              </select>
            </label>
            <label className="field">
              <span>Format</span>
              <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
                {FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABEL(f)}</option>)}
              </select>
            </label>
            <label className="field">
              <span>From</span>
              <input type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} />
            </label>
            <label className="field">
              <span>To</span>
              <input type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} />
            </label>
            {errors.time && <em className="field__error options__error">{errors.time}</em>}
          </div>
        )}
      </div>
    </form>
  );
}
