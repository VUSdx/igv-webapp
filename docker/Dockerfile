# syntax=docker/dockerfile:1

# IGV-Web App container
#

# ---- Serve stage ----------------------------------------------------------
FROM nginx:stable-alpine

# Serve the static build output.
COPY dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
