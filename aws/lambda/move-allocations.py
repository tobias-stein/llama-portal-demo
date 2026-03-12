"""
move-allocations Lambda
=======================
Validates and executes a drag-and-drop re-allocation of a booking segment
from one room to another, swapping any conflicting segments atomically.

Event payload:
  {
    "bookingId":      "abc123",          # booking whose segment is being moved
    "fromRoomId":     "room-x",          # source room
    "toRoomId":       "room-y",          # destination room
    "segmentCheckin": "2025-06-01",      # first day of the dragged segment (inclusive)
    "segmentCheckout":"2025-06-08"       # day AFTER the last day (exclusive, same convention as booking checkout)
  }

Validation rules
----------------
1. fromRoomId != toRoomId
2. bookingId must occupy fromRoomId for every date in [segmentCheckin, segmentCheckout)
3. bookingId must NOT already occupy toRoomId for any date in that range
4. For each displaced booking D whose contiguous segment on toRoomId overlaps the drag range:
   - D's FULL contiguous segment is relocated to fromRoomId
   - For any date in D's segment that falls OUTSIDE our drag range, fromRoomId must be free
     (i.e. no third booking occupies it - the dragged booking vacated its own dates)

Write strategy
--------------
- All deletes first, then all puts (minimises window of partial state)
- On any write error: explicit rollback restores the original items
- After successful writes: update BOOKING#META.roomIds for all affected bookings
"""

import os
import json
import boto3
from datetime import date, timedelta
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

TABLE_NAME = os.environ.get("TABLE_NAME", "LlamaBookings")
dynamodb   = boto3.resource("dynamodb")
table      = dynamodb.Table(TABLE_NAME)


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def daterange(start: date, end: date):
    """Yield each date in [start, end)."""
    d = start
    while d < end:
        yield d
        d += timedelta(days=1)


def get_alloc_item(room_id: str, date_str: str) -> dict | None:
    """Single get_item for one room-date allocation."""
    resp = table.get_item(Key={"PK": f"ROOM#{room_id}", "SK": f"DATE#{date_str}"})
    return resp.get("Item")


def get_booking_allocs_on_room(booking_id: str, room_id: str) -> list[dict]:
    """
    Query GSI1 (BOOKING#{bid}) and filter for items whose PK is ROOM#{room_id}.
    Returns allocation item dicts.
    """
    resp = table.query(
        IndexName="GSI1",
        KeyConditionExpression=Key("GSI1PK").eq(f"BOOKING#{booking_id}"),
    )
    return [item for item in resp.get("Items", []) if item.get("PK") == f"ROOM#{room_id}"]


def build_contiguous_segments(alloc_items: list[dict]) -> list[dict]:
    """
    Given a list of allocation items (all for the same booking on the same room),
    split them into contiguous date runs.

    Returns list of:
      { "checkin": date, "checkout": date (exclusive), "items": {date_str: item} }
    """
    if not alloc_items:
        return []

    alloc_items = sorted(alloc_items, key=lambda x: x["allocationDate"])
    segments, seg = [], None

    for item in alloc_items:
        d_str = item["allocationDate"]
        d = date.fromisoformat(d_str)
        if seg is None:
            seg = {"checkin": d, "checkout": d + timedelta(days=1), "items": {d_str: item}}
        elif d == seg["checkout"]:
            seg["checkout"] = d + timedelta(days=1)
            seg["items"][d_str] = item
        else:
            segments.append(seg)
            seg = {"checkin": d, "checkout": d + timedelta(days=1), "items": {d_str: item}}

    segments.append(seg)
    return segments


def update_booking_room_ids(booking_id: str) -> None:
    """Re-derive roomIds for a booking from its current GSI1 allocations and patch META."""
    resp = table.query(
        IndexName="GSI1",
        KeyConditionExpression=Key("GSI1PK").eq(f"BOOKING#{booking_id}"),
    )
    room_ids = sorted({item["PK"].replace("ROOM#", "") for item in resp.get("Items", [])})
    table.update_item(
        Key={"PK": f"BOOKING#{booking_id}", "SK": "META"},
        UpdateExpression="SET roomIds = :r",
        ExpressionAttributeValues={":r": room_ids},
    )


# ─────────────────────────────────────────────────────────────
# Handler
# ─────────────────────────────────────────────────────────────

def lambda_handler(event, context):
    try:
        booking_id   = event["bookingId"]
        from_room    = event["fromRoomId"]
        to_room      = event["toRoomId"]
        seg_checkin  = date.fromisoformat(event["segmentCheckin"])
        seg_checkout = date.fromisoformat(event["segmentCheckout"])

        if from_room == to_room:
            raise ValueError("Source and destination rooms must be different.")
        if seg_checkout <= seg_checkin:
            raise ValueError("segmentCheckout must be after segmentCheckin.")

        seg_dates     = {d.isoformat() for d in daterange(seg_checkin, seg_checkout)}
        seg_dates_asc = sorted(seg_dates)

        # ── 1. Verify booking owns fromRoom for every date in the segment ──────
        from_room_items: dict[str, dict] = {}
        for d in daterange(seg_checkin, seg_checkout):
            d_str = d.isoformat()
            item  = get_alloc_item(from_room, d_str)
            if item is None:
                raise ValueError(f"No allocation found: room {from_room} on {d_str}.")
            if item["bookingId"] != booking_id:
                raise ValueError(
                    f"Room {from_room} on {d_str} belongs to booking "
                    f"{item['bookingId'][:8]}, not {booking_id[:8]}."
                )
            from_room_items[d_str] = item

        # ── 2. Booking must NOT already be on toRoom within the segment range ──
        for d in daterange(seg_checkin, seg_checkout):
            item = get_alloc_item(to_room, d.isoformat())
            if item and item["bookingId"] == booking_id:
                raise ValueError(
                    f"Booking {booking_id[:8]} already occupies room {to_room} "
                    f"on {d.isoformat()}. Cannot move a segment to a room where "
                    "the same booking is already allocated."
                )

        # ── 3. Identify displaced booking IDs (what's currently on toRoom in range) ──
        displaced_booking_ids: set[str] = set()
        for d in daterange(seg_checkin, seg_checkout):
            item = get_alloc_item(to_room, d.isoformat())
            if item:
                displaced_booking_ids.add(item["bookingId"])

        # ── 4. For each displaced booking, find its full contiguous segment(s)
        #       on toRoom that overlap [seg_checkin, seg_checkout) ──────────────
        #
        # "Full segment" = the entire contiguous run on toRoom that contains the
        # overlapping dates.  We relocate the whole run, not just the overlapping
        # portion, so that booking bars remain contiguous on the destination room.
        displaced_segments: dict[str, dict[str, dict]] = {}
        # displaced_segments[booking_id][date_str] = original allocation item

        for bid in displaced_booking_ids:
            alloc_items_on_to = get_booking_allocs_on_room(bid, to_room)
            contiguous = build_contiguous_segments(alloc_items_on_to)

            for seg in contiguous:
                # Overlap check: [seg.checkin, seg.checkout) ∩ [seg_checkin, seg_checkout)
                if seg["checkout"] <= seg_checkin or seg["checkin"] >= seg_checkout:
                    continue
                # This segment overlaps → relocate its full date range
                if bid not in displaced_segments:
                    displaced_segments[bid] = {}
                displaced_segments[bid].update(seg["items"])

        # ── 5. Validate: displaced dates OUTSIDE the drag range need fromRoom free ─
        #
        # Inside the drag range, fromRoom is vacated by booking_id (step A below),
        # so it will be free.  Outside the range we must check explicitly.
        for bid, date_items in displaced_segments.items():
            for d_str in date_items:
                if d_str not in seg_dates:
                    blocker = get_alloc_item(from_room, d_str)
                    if blocker:
                        raise ValueError(
                            f"Cannot relocate booking {bid[:8]}: "
                            f"room {from_room} is occupied on {d_str} "
                            f"by booking {blocker['bookingId'][:8]}."
                        )

        # ── 6. Build write plan (deletes then puts) ──────────────────────────────
        # We save originals for rollback before touching anything.

        # Deletes: (PK, SK) tuples
        # Puts:    full item dicts (with updated PK / GSI2SK)
        deletes: list[tuple[str, str]] = []
        puts:    list[dict]            = []

        # A) Remove booking_id from fromRoom for each segment date
        for d_str in seg_dates_asc:
            deletes.append((f"ROOM#{from_room}", f"DATE#{d_str}"))

        # B) Place booking_id on toRoom for each segment date
        for d_str in seg_dates_asc:
            orig = from_room_items[d_str]
            puts.append({
                **orig,
                "PK":     f"ROOM#{to_room}",
                "SK":     f"DATE#{d_str}",
                # GSI2PK stays DATE#{month} (same date, same month)
                "GSI2SK": f"DATE#{d_str}#ROOM#{to_room}",
            })

        # C) Relocate each displaced booking's full segment from toRoom → fromRoom
        for bid, date_items in displaced_segments.items():
            for d_str in sorted(date_items.keys()):
                orig = date_items[d_str]
                # Delete from toRoom only for dates outside our seg range.
                # Dates inside our range are overwritten by step B's put_item.
                if d_str not in seg_dates:
                    deletes.append((f"ROOM#{to_room}", f"DATE#{d_str}"))
                # Write to fromRoom
                puts.append({
                    **orig,
                    "PK":     f"ROOM#{from_room}",
                    "SK":     f"DATE#{d_str}",
                    "GSI2SK": f"DATE#{d_str}#ROOM#{from_room}",
                })

        # ── 7. Execute: deletes first, then puts ────────────────────────────────
        completed_deletes: list[tuple[str, str]] = []
        completed_puts:    list[tuple[str, str]] = []

        try:
            for pk, sk in deletes:
                table.delete_item(Key={"PK": pk, "SK": sk})
                completed_deletes.append((pk, sk))

            for item in puts:
                table.put_item(Item=item)
                completed_puts.append((item["PK"], item["SK"]))

        except Exception as write_err:
            print(f"Write failed — rolling back. Error: {write_err}")

            # Rollback puts (delete what we wrote)
            for pk, sk in reversed(completed_puts):
                try:
                    table.delete_item(Key={"PK": pk, "SK": sk})
                except Exception as rb_err:
                    print(f"Rollback delete error: {rb_err}")

            # Rollback deletes (restore originals)
            all_original_items = {
                **from_room_items,
                **{d_str: item for bid_items in displaced_segments.values()
                   for d_str, item in bid_items.items()},
            }
            for pk, sk in reversed(completed_deletes):
                d_str = sk.replace("DATE#", "")
                orig  = all_original_items.get(d_str)
                if orig:
                    try:
                        table.put_item(Item=orig)
                    except Exception as rb_err:
                        print(f"Rollback put error: {rb_err}")

            raise write_err

        # ── 8. Update BOOKING#META roomIds for all affected bookings ────────────
        for bid in ({booking_id} | set(displaced_segments.keys())):
            try:
                update_booking_room_ids(bid)
            except Exception as meta_err:
                # Non-critical: allocations are correct, metadata is stale but recoverable
                print(f"Failed to update roomIds for {bid}: {meta_err}")

        return {
            "statusCode": 200,
            "body": json.dumps({
                "message": "Allocation moved successfully",
                "movedBookingId": booking_id,
                "fromRoom": from_room,
                "toRoom":   to_room,
                "displacedBookings": list(displaced_segments.keys()),
            }),
        }

    except ValueError as e:
        return {"statusCode": 400, "body": json.dumps({"error": str(e)})}
    except Exception as e:
        import traceback
        print(f"Unexpected error in move-allocations:")
        traceback.print_exc()
        return {"statusCode": 500, "body": json.dumps({"error": "Internal server error", "detail": str(e)})}