import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { ActivityFilterError, getActivityData } from '$lib/server/admin/activity';

export const load: PageServerLoad = async ({ url }) => {
  const date = url.searchParams.get('date');
  const startDate = url.searchParams.get('startDate');
  const endDate = url.searchParams.get('endDate');
  const classification = url.searchParams.get('classification');
  const q = url.searchParams.get('q');
  const page = url.searchParams.get('page');
  const pageSize = url.searchParams.get('pageSize');

  try {
    const activity = getActivityData(runtime.db, runtime.classification, {
      date,
      startDate,
      endDate,
      classification,
      q,
      page,
      pageSize
    });

    return { activity };
  } catch (err) {
    // A rejected filter is the caller's mistake, so it surfaces as 400 with the
    // validator's own message. Anything else is a genuine server fault and
    // keeps its default 500 handling rather than being relabelled here.
    if (err instanceof ActivityFilterError) {
      error(err.status, err.message);
    }
    throw err;
  }
};
