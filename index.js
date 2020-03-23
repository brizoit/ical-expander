/**
 * BrizotIT changes:
 *
 * 1. Add all timezones from incoming iCalendar, see brizoit #1.
 * 2. Timezones export. See brizoit #2.
 * 3. Corrected so all day events get startTime/endTime in current user time zone.
 * Use moment object which is already initilized with user's time zone. Before this fix first and last period events
 * could be skipped when user's timezone was not matching computer timezone. See brizoit #3.
 * 4. Added zones-jira.json to support Zones like UTC and GMT* that we have in Jira, see brizoit #4.
 */

'use strict';

const ICAL = require('ical.js');

// Copied from https://dxr.mozilla.org/comm-central/source/calendar/timezones/zones.json
// And compiled using node compile-zones.js
// See also https://github.com/mozilla-comm/ical.js/issues/195
// brizoit #4: Added zones-jira.json
const timezones = Object.assign(require('./zones-compiled.json'), require('./zones-jira.json'));

class IcalExpander {
  constructor(opts) {
    this.maxIterations = opts.maxIterations != null ? opts.maxIterations : 1000;
    this.skipInvalidDates = opts.skipInvalidDates != null ? opts.skipInvalidDates : false;

    this.jCalData = ICAL.parse(opts.ics);
    this.component = new ICAL.Component(this.jCalData);

    // brizoit #1: add all timezones
    // Add all timezones from incoming iCalendar object to TimezonService if they are not already registered.
    var vtimezones = this.component.getAllSubcomponents("vtimezone");
    vtimezones.forEach(function (vtimezone) {
      if (!ICAL.TimezoneService.has(vtimezone.getFirstPropertyValue("tzid"))) {
        ICAL.TimezoneService.register(vtimezone);
      }
    });

    this.events = this.component.getAllSubcomponents('vevent').map(vevent => new ICAL.Event(vevent));

    if (this.skipInvalidDates) {
      this.events = this.events.filter((evt) => {
        try {
          evt.startDate.toJSDate();
          evt.endDate.toJSDate();
          return true;
        } catch (err) {
          // skipping events with invalid time
          return false;
        }
      });
    }
  }

  between(after, before) {
    function isEventWithinRange(startTime, endTime) {
      return (!after || endTime >= after.getTime()) &&
      (!before || startTime <= before.getTime());
    }

    function getTimes(eventOrOccurrence) {
      // brizoit #3: all day events get correct startTime/endTime
      var startTime = eventOrOccurrence.startDate.isDate ?
        moment(eventOrOccurrence.startDate.toString()).unix() * 1000 :
        eventOrOccurrence.startDate.toJSDate().getTime();
      // brizoit #3: all day events get correct startTime / endTime
      var endTime = eventOrOccurrence.endDate.isDate ?
        moment(eventOrOccurrence.endDate.toString()).unix() * 1000 :
        eventOrOccurrence.endDate.toJSDate().getTime();

      // If it is an all day event, the end date is set to 00:00 of the next day
      // So we need to make it be 23:59:59 to compare correctly with the given range
      if (eventOrOccurrence.endDate.isDate && (endTime > startTime)) {
        endTime -= 1;
      }

      return { startTime, endTime };
    }

    const exceptions = [];

    this.events.forEach((event) => {
      if (event.isRecurrenceException()) exceptions.push(event);
    });

    const ret = {
      events: [],
      occurrences: [],
    };

    this.events.filter(e => !e.isRecurrenceException()).forEach((event) => {
      const exdates = [];

      event.component.getAllProperties('exdate').forEach((exdateProp) => {
        const exdate = exdateProp.getFirstValue();
        exdates.push(exdate.toJSDate().getTime());
      });

      // Recurring event is handled differently
      if (event.isRecurring()) {
        const iterator = event.iterator();

        let next;
        let i = 0;

        do {
          i += 1;
          next = iterator.next();
          if (next) {
            const occurrence = event.getOccurrenceDetails(next);

            const { startTime, endTime } = getTimes(occurrence);

            const isOccurrenceExcluded = exdates.indexOf(startTime) !== -1;

            // TODO check that within same day?
            const exception = exceptions.find(ex => ex.uid === event.uid && ex.recurrenceId.toJSDate().getTime() === occurrence.startDate.toJSDate().getTime());

            // We have passed the max date, stop
            if (before && startTime > before.getTime()) break;

            // Check that we are within our range
            if (isEventWithinRange(startTime, endTime)) {
              if (exception) {
                ret.events.push(exception);
              } else if (!isOccurrenceExcluded) {
                ret.occurrences.push(occurrence);
              }
            }
          }
        }
        while (next && (!this.maxIterations || i < this.maxIterations));

        return;
      }

      // Non-recurring event:
      const { startTime, endTime } = getTimes(event);

      if (isEventWithinRange(startTime, endTime)) ret.events.push(event);
    });

    return ret;
  }

  before(before) {
    return this.between(undefined, before);
  }

  after(after) {
    return this.between(after);
  }

  all() {
    return this.between();
  }
}

function registerTimezones() {
  Object.keys(timezones).forEach((key) => {
    const icsData = timezones[key];
    const parsed = ICAL.parse(`BEGIN:VCALENDAR\nPRODID:-//tzurl.org//NONSGML Olson 2012h//EN\nVERSION:2.0\n${icsData}\nEND:VCALENDAR`);
    const comp = new ICAL.Component(parsed);
    const vtimezone = comp.getFirstSubcomponent('vtimezone');

    ICAL.TimezoneService.register(key, new ICAL.Timezone(vtimezone));
  });
}

registerTimezones();

// brizoit #2: timezones export
module.exports.ICalExpander = IcalExpander;
module.exports.TIME_ZONES = timezones;