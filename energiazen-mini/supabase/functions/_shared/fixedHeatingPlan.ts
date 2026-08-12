export type FixedHeatingHour = {
  date: Date;
  endDate: Date;
  price: number;
};

export function selectRemainingFixedHeatingHours<T extends FixedHeatingHour>({
  completedHeatingHours,
  fixedHeatingHoursPerDay,
  hours,
  now,
}: {
  completedHeatingHours: number;
  fixedHeatingHoursPerDay: number;
  hours: T[];
  now: Date;
}) {
  const remainingCount = Math.max(
    fixedHeatingHoursPerDay - completedHeatingHours,
    0,
  );

  return [...hours]
    .filter((hour) => hour.endDate.getTime() > now.getTime())
    .sort((first, second) => {
      if (first.price === second.price) {
        return first.date.getTime() - second.date.getTime();
      }

      return first.price - second.price;
    })
    .slice(0, remainingCount);
}
