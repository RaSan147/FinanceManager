import datetime
import socket
from typing import Optional, Union
import ntplib  # pip install ntplib


def get_network_time(utc: bool = False) -> datetime.datetime:
	"""
	Retrieve the current time using a list of NTP servers with fallback to system time.

	Args:
		utc (bool): If True, returns time in UTC; otherwise, local timezone.

	Returns:
		datetime.datetime: Current time with timezone information.
	"""
	# List of NTP servers to query
	NTP_SERVERS = [
		'pool.ntp.org',
		'time.nist.gov',
		'time.google.com',
		'time.windows.com',
		'ntp.ubuntu.com'
	]

	ntp_client = ntplib.NTPClient()

	for server in NTP_SERVERS:
		try:
			# Request time from the current server
			response = ntp_client.request(server, timeout=2)
			# Convert timestamp to a datetime object with UTC timezone
			network_time = datetime.datetime.fromtimestamp(response.tx_time, datetime.timezone.utc)
			return network_time if utc else network_time.astimezone()
		except (ntplib.NTPException, socket.gaierror, socket.timeout, OSError) as e:
			continue  # Try the next server if this one fails

	# If all NTP servers fail, fallback to local system time
	return datetime.datetime.now(datetime.timezone.utc) if utc else datetime.datetime.now().astimezone()


class DateTimeUtils:
	"""
	A utility class for parsing, formatting, converting timezones,
	and extracting timestamps from datetime objects or strings.
	"""
	OUTPUT_FORMAT = "%Y-%m-%d %H:%M:%S %z"  # Default output format for datetime strings

	# List of supported input formats for parsing
	INPUT_FORMATS = [
		OUTPUT_FORMAT,
		"%Y-%m-%d~~%H:%M:%S[%z]",
		"%Y-%m-%d~~%H:%M:%S",
		"%Y-%m-%d>>%H:%M:%S",
		"%Y-%m-%d %H:%M:%S %z",
		"%Y-%m-%d %H:%M:%S",
		"%Y-%m-%d %H:%M:%S.%f %z",
		"%Y-%m-%d %H:%M:%S.%f",
		"%Y-%m-%d %H:%M %z",
		"%Y-%m-%d %H:%M",
		"%Y/%m/%d %H:%M:%S %z",
		"%Y/%m/%d %H:%M:%S",
		"%Y/%m/%d %H:%M %z",
		"%Y/%m/%d %H:%M",
	]

	FORCE_UTC_WHEN_UNSPECIFIED = True  # If timezone is not given, default to UTC
	FORCE_TZ_IF_UNSPECIFIED: Optional[float] = 0  # Optionally override naive datetime with specific offset

	@classmethod
	def now(cls, utc: bool = False, online=True) -> datetime.datetime:
		"""
		Get the current time as a formatted string.

		Args:
			utc (bool): Whether to return UTC or local time.
			str_format (Optional[str]): Optional custom format.
			online (bool): Whether to fetch network time or use system time.

		Returns:
			datetime.datetime: Current time in the specified format.
		"""
		dt = get_network_time(utc) if online else datetime.datetime.now(datetime.timezone.utc if utc else cls._local_tz())

		return dt

	@classmethod
	def _local_tz(cls) -> datetime.tzinfo:
		"""
		Return system's local timezone as tzinfo object.

		Returns:
			datetime.tzinfo: Local timezone info.
		"""
		return datetime.datetime.now().astimezone().tzinfo

	@classmethod
	def _parse_tz(cls, tz: Union[float, datetime.tzinfo]) -> datetime.tzinfo:
		"""
		Convert timezone input (float or tzinfo) to tzinfo object.

		Args:
			tz: Timezone as either float (hours offset) or tzinfo object.

		Returns:
			datetime.tzinfo: Timezone object.
		"""
		if isinstance(tz, datetime.tzinfo):
			return tz
		return datetime.timezone(datetime.timedelta(hours=tz))

	@classmethod
	def to_dt(
		cls,
		obj: Union[str, datetime.datetime],
		str_format: Optional[str] = None,
		forced_tz_if_missing: Optional[Union[float, datetime.tzinfo]] = None,
		invalid="Raise"
	) -> datetime.datetime:
		"""
		Convert a string or datetime into a timezone-aware datetime object.

		Args:
			obj (Union[str, datetime.datetime]): Input datetime string or object.
			str_format (Optional[str]): Specific format to try first.
			forced_tz_if_missing (Optional[Union[float, datetime.tzinfo]]): Use this offset if input is naive.

		Returns:
			datetime.datetime: Timezone-aware datetime object.
		"""
		if isinstance(obj, datetime.datetime):
			dt_obj = obj
		elif isinstance(obj, str):
			obj = obj.strip()  # Clean up whitespace
			str_formats = [str_format] if str_format else cls.INPUT_FORMATS
			for fmt in str_formats:
				try:
					dt_obj = datetime.datetime.strptime(obj, fmt)
					break
				except ValueError:
					continue
			else:
				raise ValueError(f"String '{obj}' does not match any expected formats: {str_formats}")
		else:
			if invalid=="Raise":
				raise TypeError("Input must be a str or datetime.datetime")
			return invalid

		if dt_obj.tzinfo is None:
			# Apply forced timezone if missing
			if forced_tz_if_missing is not None:
				tzinfo = cls._parse_tz(forced_tz_if_missing)
				dt_obj = dt_obj.replace(tzinfo=tzinfo)
			elif cls.FORCE_TZ_IF_UNSPECIFIED is not None:
				dt_obj = dt_obj.replace(tzinfo=datetime.timezone(datetime.timedelta(hours=cls.FORCE_TZ_IF_UNSPECIFIED)))
			elif cls.FORCE_UTC_WHEN_UNSPECIFIED:
				dt_obj = dt_obj.replace(tzinfo=datetime.timezone.utc)
			else:
				local_tz = cls._local_tz()
				if local_tz:
					dt_obj = dt_obj.replace(tzinfo=local_tz)

		return dt_obj

	@classmethod
	def to_str(
		cls,
		dt: Union[str, datetime.datetime],
		str_format: Optional[str] = None,
		forced_tz_if_missing: Optional[Union[float, datetime.tzinfo]] = None
	) -> str:
		"""
		Format a datetime object or string to a formatted string.

		Args:
			dt (Union[str, datetime.datetime]): Input datetime.
			str_format (Optional[str]): Output format string.
			forced_tz_if_missing (Optional[Union[float, datetime.tzinfo]]): Timezone to apply if missing.

		Returns:
			str: Formatted datetime string.
		"""
		dt_obj = cls.to_dt(dt, str_format, forced_tz_if_missing)
		return dt_obj.strftime(str_format or cls.OUTPUT_FORMAT)

	@classmethod
	def to_timestamp(
		cls,
		dt: Union[str, datetime.datetime],
		str_format: Optional[str] = None,
		forced_tz_if_missing: Optional[Union[float, datetime.tzinfo]] = None
	) -> float:
		"""
		Convert datetime object or string to UNIX timestamp.

		Args:
			dt (Union[str, datetime.datetime]): Input datetime.
			str_format (Optional[str]): Input format if string.
			forced_tz_if_missing (Optional[Union[float, datetime.tzinfo]]): Timezone if input is naive (TZ missing).

		Returns:
			float: UNIX timestamp.
		"""
		dt_obj = cls.to_dt(dt, str_format, forced_tz_if_missing)
		return dt_obj.timestamp()

	@classmethod
	def to_tz(
		cls,
		dt: Union[str, datetime.datetime],
		tz: Union[float, datetime.tzinfo],
		str_format: Optional[str] = None,
		forced_tz_if_missing: Optional[Union[float, datetime.tzinfo]] = None
	) -> datetime.datetime:
		"""
		Convert a datetime to a different timezone.

		Args:
			dt (Union[str, datetime.datetime]): Input datetime.
			tz (Union[float, datetime.tzinfo]): Target timezone as offset (hours) or tzinfo object.
			str_format (Optional[str]): Output format.
			forced_tz_if_missing (Optional[Union[float, datetime.tzinfo]]): Use this if input has no timezone.

		Returns:
			datetime.datetime: Datetime in the target timezone.
		"""
		dt_obj = cls.to_dt(dt, str_format, forced_tz_if_missing)
		target_time_zone = cls._parse_tz(tz)
		return dt_obj.astimezone(target_time_zone)

	@classmethod
	def to_utc(
		cls,
		dt: Union[str, datetime.datetime],
		str_format: Optional[str] = None
	) -> datetime.datetime:
		"""
		Convert a timezone-aware datetime to UTC. Raises ValueError if datetime is naive.

		Args:
			dt (Union[str, datetime.datetime]): Input datetime (must be timezone-aware).
			str_format (Optional[str]): Format of input string (if applicable).

		Returns:
			datetime.datetime: UTC datetime.

		Raises:
			ValueError: If input datetime is naive (no timezone info).
		"""
		dt_obj = cls.to_dt(dt, str_format, forced_tz_if_missing=None)
		if dt_obj.tzinfo is None:
			raise ValueError("Cannot convert naive datetime to UTC. Datetime must have timezone info.")
		return dt_obj.astimezone(datetime.timezone.utc)

	@classmethod
	def to_local(
		cls,
		dt: Union[str, datetime.datetime],
		str_format: Optional[str] = None,
		forced_tz_if_missing: Optional[Union[float, datetime.tzinfo]] = None
	) -> datetime.datetime:
		"""
		Convert a datetime to local timezone.

		Args:
			dt (Union[str, datetime.datetime]): Input datetime.
			str_format (Optional[str]): Format of input string (if applicable).
			forced_tz_if_missing (Optional[Union[float, datetime.tzinfo]]): Explicit override for timezone offset if missing.

		Returns:
			datetime.datetime: Local timezone-aware datetime.
		"""
		return cls.to_tz(dt, tz=cls._local_tz(), str_format=str_format, forced_tz_if_missing=forced_tz_if_missing)

	@classmethod
	def from_utc_to_local(
		cls,
		dt: Union[str, datetime.datetime],
		str_format: Optional[str] = None,
		forced_tz_if_missing: Optional[Union[float, datetime.tzinfo]] = None
	) -> datetime.datetime:
		"""
		Convert UTC datetime to local timezone.

		Args:
			dt (Union[str, datetime.datetime]): Input datetime.
			str_format (Optional[str]): Format of input string (if applicable).
			forced_tz_if_missing (Optional[Union[float, datetime.tzinfo]]): Explicit override for timezone offset if missing.

		Returns:
			datetime.datetime: Local timezone-aware datetime.
		"""
		return cls.to_tz(dt, tz=cls._local_tz(), str_format=str_format, forced_tz_if_missing=forced_tz_if_missing)

	@classmethod
	def from_tz_to_utc(
		cls,
		dt: Union[str, datetime.datetime],
		tz: Union[float, datetime.tzinfo] = 0,
		str_format: Optional[str] = None,
		forced_tz_if_missing: Optional[Union[float, datetime.tzinfo]] = None
	) -> datetime.datetime:
		"""
		Convert datetime from a given timezone to UTC.

		Args:
			dt (Union[str, datetime.datetime]): Input datetime.
			tz (Union[float, datetime.tzinfo]): Fallback timezone if input is naive.
			str_format (Optional[str]): Format of input string (if applicable).
			forced_tz_if_missing (Optional[Union[float, datetime.tzinfo]]): Explicit override for timezone if missing.

		Returns:
			datetime.datetime: UTC-aware datetime.
		"""
		return cls.from_tz_to_tz(
			dt=dt,
			from_tz=tz,
			to_tz=0,
			str_format=str_format,
			forced_tz_if_missing=forced_tz_if_missing
		)

	@classmethod
	def from_tz_to_tz(
		cls,
		dt: Union[str, datetime.datetime],
		from_tz: Union[float, datetime.tzinfo, None] = None,
		to_tz: Union[float, datetime.tzinfo] = 0,
		str_format: Optional[str] = None,
		forced_tz_if_missing: Optional[Union[float, datetime.tzinfo]] = None
	) -> datetime.datetime:
		"""
		Convert datetime from one timezone to another.

		Args:
			dt: Input datetime.
			from_tz: Source timezone (used if tzinfo is missing).
			to_tz: Destination timezone.
			str_format: Format of input string (if applicable).
			forced_tz_if_missing: Explicit override for timezone if missing.

		Returns:
			datetime.datetime: Datetime converted to the target timezone.
		"""
		# Choose fallback timezone if tzinfo is missing
		fallback = forced_tz_if_missing if forced_tz_if_missing is not None else from_tz
		dt_obj = cls.to_dt(dt, str_format, forced_tz_if_missing=fallback)
		
		# Convert to desired timezone
		target_time_zone = cls._parse_tz(to_tz)
		return dt_obj.astimezone(target_time_zone)


# -------------------- Test / Example --------------------
if __name__ == "__main__":
	# Show current time in UTC and local time
	print("UTC now: \t ", DateTimeUtils.now(utc=True))
	print("Local now: \t ", DateTimeUtils.now(utc=False))
	print("EST now (-4): \t ", DateTimeUtils.to_tz(DateTimeUtils.now(utc=True), tz=-4))

	# Sample naive datetime string (no timezone info)
	naive_str = "2023-10-01~~12:00:00"

	# Parse naive string and interpret it as UTC or +6 timezone
	print("(naive)\t Parsed (naive): \t ", DateTimeUtils.to_dt(naive_str))
	print("(naive)\t Parsed (forced +6): \t ", DateTimeUtils.to_dt(naive_str, forced_tz_if_missing=6))

	# Convert to formatted string
	print("(naive)\t String format: \t ", DateTimeUtils.to_str(naive_str))

	# Convert to timestamp
	print("(naive)\t Timestamp: \t ", DateTimeUtils.to_timestamp(naive_str, forced_tz_if_missing=6))

	# Convert to another timezone using both float and tzinfo
	print("(naive)\t To +6 (float): \t ", DateTimeUtils.to_tz(naive_str, tz=6, forced_tz_if_missing=0))
	print("(naive)\t To +6 (tzinfo): \t ", DateTimeUtils.to_tz(naive_str, 
		tz=datetime.timezone(datetime.timedelta(hours=6)), 
		forced_tz_if_missing=0))

	# Convert from +6 timezone to UTC
	print("(naive)\t From +6 to UTC: \t ", DateTimeUtils.from_tz_to_utc(naive_str, tz=6))

	# Convert from +6 to +3 timezone
	print("(naive)\t From +6 to +3: \t ", DateTimeUtils.from_tz_to_tz(naive_str, from_tz=6, to_tz=3))

	# Convert from UTC to local timezone
	print("(naive)\t From UTC to local: \t ", DateTimeUtils.from_utc_to_local(naive_str, forced_tz_if_missing=0))

	# Convert from +2 timezone to Local timezone
	print("(naive)\t From +2 to Local: \t ", DateTimeUtils.to_local(naive_str, forced_tz_if_missing=2))

	try:
		print("(naive)\t To UTC: \t ", DateTimeUtils.to_utc(naive_str))
	except ValueError as e:
		print("Expected error for naive datetime:", e)
	# Test new to_utc function
	tz_aware_str = "2023-10-01 12:00:00 +0600"
	print("(tz-aware)\t To UTC : \t ", DateTimeUtils.to_utc(tz_aware_str))

	tz_aware_str2 = "2023-10-01 12:00:00 +0430"
	print("(tz-aware)\t To UTC : \t ", DateTimeUtils.to_utc(tz_aware_str2))

	# Test with timezone-aware datetime to local
	print("(tz-aware)\t To Local: \t ", DateTimeUtils.to_local(tz_aware_str, forced_tz_if_missing=0))
	print("(tz-aware)\t To Local: \t ", DateTimeUtils.to_local(tz_aware_str2, forced_tz_if_missing=0))
	