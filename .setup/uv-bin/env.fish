if not contains "$HOME/Documents/Construct/.setup/uv-bin" $PATH
    # Prepending path in case a system-installed binary needs to be overridden
    set -x PATH "$HOME/Documents/Construct/.setup/uv-bin" $PATH
end
