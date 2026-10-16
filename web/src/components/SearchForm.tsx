// Skeleton: pure form, no fetching. Lane B restyles from the mockups.
import { useState, type FormEvent } from "react";
import type { BookingRequest, SearchRequest } from "../../../shared/types";
import { localDate } from "../format";

export type SeatPref = BookingRequest["seat_pref"];

export type SearchFormProps = {
  initial?: Partial<SearchRequest> & { seat_pref?: SeatPref };
  busy: boolean;
  onSubmit: (req: SearchRequest, seatPref: SeatPref) => void;
};

const NYC_ZIP = /^(10[0-4]|11[0-4]|116)\d{2}$/;
const FORMATS: NonNullable<SearchRequest["format"]>[] = ["any", "imax", "dolby", "standard"];

export function SearchForm({ initial, busy, onSubmit }: SearchFormProps) {
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

  const errors = {
    movie: movie.trim() ? "" : "Enter a movie",
    zip: !/^\d{5}$/.test(zip) ? "Enter a 5-digit zip" : !NYC_ZIP.test(zip) ? "NYC zips only" : "",
    date: date < today || date > maxDate ? "Pick a date in the next 2 weeks" : "",
    time: timeFrom && timeTo && timeFrom > timeTo ? "“From” must be before “To”" : "",
  };
  const valid = !Object.values(errors).some(Boolean);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    onSubmit({
      movie: movie.trim(), zip, date, party_size: party, format,
      ...(timeFrom ? { time_from: timeFrom } : {}),
      ...(timeTo ? { time_to: timeTo } : {}),
    }, seatPref);
  };

  return (
    <form className="search-form" onSubmit={submit} noValidate>
      <label className="field field--wide">
        <span>Movie</span>
        <input value={movie} onChange={(e) => setMovie(e.target.value)} placeholder="e.g. Street Fighter" autoFocus />
        {movie && errors.movie && <em className="field__error">{errors.movie}</em>}
      </label>
      <label className="field">
        <span>Zip</span>
        <input value={zip} inputMode="numeric" maxLength={5} placeholder="10018"
          onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))} />
        {zip && errors.zip && <em className="field__error">{errors.zip}</em>}
      </label>
      <label className="field">
        <span>Date</span>
        <input type="date" value={date} min={today} max={maxDate} onChange={(e) => setDate(e.target.value)} />
        {errors.date && <em className="field__error">{errors.date}</em>}
      </label>
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
          {FORMATS.map((f) => <option key={f} value={f}>{f === "any" ? "Any" : f === "imax" ? "IMAX" : f[0].toUpperCase() + f.slice(1)}</option>)}
        </select>
      </label>
      <label className="field">
        <span>From</span>
        <input type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} />
      </label>
      <label className="field">
        <span>To</span>
        <input type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} />
        {errors.time && <em className="field__error">{errors.time}</em>}
      </label>
      <button className="btn btn--primary search-form__submit" type="submit" disabled={!valid || busy}>
        {busy ? "Searching…" : "Find showtimes"}
      </button>
    </form>
  );
}
