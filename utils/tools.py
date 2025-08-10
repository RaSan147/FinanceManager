def is_allowed_email_address(email, allowed_list=[]):
	if not allowed_list:
		return True
	return email in allowed_list

def is_allowed_email_domain(email, allowed_domains=[]):
	if not allowed_domains:
		return True
	domain = email.split('@')[-1]
	return domain in allowed_domains


def is_allowed_email(email, allowed_emails=[], allowed_domains=[]):
	return is_allowed_email_address(email, allowed_emails) and is_allowed_email_domain(email, allowed_domains)