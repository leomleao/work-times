import type { PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import { getActivityData } from '$lib/server/admin/activity';

export const load: PageServerLoad = async ({ url }) => {
  const date = url.searchParams.get('date');
  const startDate = url.searchParams.get('startDate');
  const endDate = url.searchParams.get('endDate');
  const classification = url.searchParams.get('classification');
  const q = url.searchParams.get('q');
  const page = url.searchParams.get('page');
  const pageSize = url.searchParams.get('pageSize');

  const activity = getActivityData(runtime.db, runtime.classification, {
    date,
    startDate,
    endDate,
    classification,
    q,
    page,
    pageSize
  });

  return {
    activity
  };
};
