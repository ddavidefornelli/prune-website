/** What a space's calendar shows besides its own tasks (see planner_list 'calendar'). */

/** In Personal: a task the person planned in one of their group spaces. */
export interface PlannedElsewhere {
  id: string;
  space: string;
  spaceName: string;
  title: string;
  startAt: number;
  minutes: number;
  done: boolean;
  notes: string;
}

/**
 * In a group space: when someone in it is busy with plans elsewhere. Merged
 * across everyone, so it never says who, or what.
 */
export interface Busy {
  start: number;
  end: number;
}
