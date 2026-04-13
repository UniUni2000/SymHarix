#!/bin/bash
# Symphony CLI - Development and Deployment Tool

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Symphony directory
SYMPHONY_DIR="${SYMPHONY_DIR:-$HOME/symphony}"

show_help() {
    echo "Symphony CLI - Enterprise Agent Platform"
    echo ""
    echo "Usage: symphony <command>"
    echo ""
    echo "Commands:"
    echo "  start       Start the Symphony server"
    echo "  stop        Stop the Symphony server"
    echo "  restart     Restart the Symphony server"
    echo "  status      Show server status"
    echo "  logs        View server logs"
    echo "  config      Interactive configuration"
    echo "  deploy      Deploy to production"
    echo "  backup      Create database backup"
    echo "  restore     Restore from backup"
    echo "  help        Show this help message"
    echo ""
}

start_server() {
    echo -e "${BLUE}Starting Symphony server...${NC}"
    cd "$SYMPHONY_DIR"
    bun run start
}

stop_server() {
    echo -e "${YELLOW}Stopping Symphony server...${NC}"
    pkill -f "bun.*symphony" || true
    echo -e "${GREEN}Server stopped${NC}"
}

show_status() {
    echo -e "${BLUE}Symphony Status:${NC}"

    # Check if running
    if pgrep -f "bun.*symphony" > /dev/null; then
        echo -e "  Server: ${GREEN}Running${NC}"
        PID=$(pgrep -f "bun.*symphony")
        echo "  PID: $PID"
    else
        echo -e "  Server: ${RED}Stopped${NC}"
    fi

    # Check database
    if [ -f "$SYMPHONY_DIR/symphony.db" ]; then
        echo -e "  Database: ${GREEN}OK${NC}"
    else
        echo -e "  Database: ${YELLOW}Not initialized${NC}"
    fi

    # Check .env
    if [ -f "$SYMPHONY_DIR/.env" ]; then
        echo -e "  Config: ${GREEN}OK${NC}"
    else
        echo -e "  Config: ${YELLOW}Not configured${NC}"
    fi
}

view_logs() {
    echo -e "${BLUE}Viewing Symphony logs...${NC}"
    cd "$SYMPHONY_DIR"

    if [ -f "symphony.log" ]; then
        tail -f symphony.log
    else
        echo -e "${YELLOW}No log file found${NC}"
    fi
}

interactive_config() {
    echo -e "${BLUE}Symphony Configuration${NC}"
    echo ""

    if [ ! -f "$SYMPHONY_DIR/.env" ]; then
        echo -e "${YELLOW}Creating new .env file...${NC}"
        cat > "$SYMPHONY_DIR/.env" << 'EOF'
# Symphony Configuration

ANTHROPIC_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_USER_ID=
LINEAR_API_KEY=
LINEAR_PROJECT_SLUG=
SERVER_PORT=8080
SERVER_HOST=0.0.0.0
WORKSPACE_ROOT=./workspaces
DATABASE_PATH=./symphony.db
EOF
    fi

    echo -e "${YELLOW}Editing $SYMPHONY_DIR/.env${NC}"
    editor="${VISUAL:-${EDITOR:-nano}}"
    "$editor" "$SYMPHONY_DIR/.env"

    echo -e "${GREEN}Configuration saved${NC}"
}

create_backup() {
    echo -e "${BLUE}Creating database backup...${NC}"

    BACKUP_DIR="$SYMPHONY_DIR/backups"
    mkdir -p "$BACKUP_DIR"

    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_FILE="$BACKUP_DIR/symphony_$TIMESTAMP.db"

    if [ -f "$SYMPHONY_DIR/symphony.db" ]; then
        cp "$SYMPHONY_DIR/symphony.db" "$BACKUP_FILE"
        echo -e "${GREEN}Backup created: $BACKUP_FILE${NC}"
    else
        echo -e "${YELLOW}No database to backup${NC}"
    fi
}

# Main command handler
case "${1:-help}" in
    start)
        start_server
        ;;
    stop)
        stop_server
        ;;
    restart)
        stop_server
        start_server
        ;;
    status)
        show_status
        ;;
    logs)
        view_logs
        ;;
    config)
        interactive_config
        ;;
    backup)
        create_backup
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        echo -e "${RED}Unknown command: $1${NC}"
        show_help
        exit 1
        ;;
esac
