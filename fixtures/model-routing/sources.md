# Synthetic support notes

Record A: the Atlas prototype uses an offline queue. Its retry interval is 37 seconds.
Record B: the Boreal prototype uses online-only requests. Its retry interval is 12 seconds.
Record C: the Ceres prototype uses an offline queue. Its retry interval is 61 seconds.

An offline field team needs requests to survive loss of connectivity and prefers
the shortest retry interval among compatible prototypes. These values describe
only this fixture and make no claim about any product.
